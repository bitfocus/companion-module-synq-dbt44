const { InstanceBase, Regex, runEntrypoint } = require('@companion-module/base')
const dgram = require('dgram')
const dns = require('dns')
const osc = require('osc')

const UpgradeScripts = require('./upgrades')
const UpdateActions = require('./actions')
const UpdateFeedbacks = require('./feedbacks')
const UpdateVariables = require('./variables')

/**
 * DBT-44 OSC protocol:
 * - UDP, device receives on port 9000, device sends (responses) on port 9001.
 * - Every URL must end with /<device_name> (identifier set on the unit, e.g. from web interface).
 * - /ping sends back the same command to test if device is on the network.
 * - /sync returns all current settings from the device (OSC messages, often in a bundle).
 * - Sending a URL without a parameter value = "get", device returns current state.
 * See https://synq-audio.com/dbt-44 for more information.
 */
const OSC_PATH_PING = '/ping'
const OSC_PATH_SYNC = '/sync'
const SYNC_INTERVAL_MS = 60000 // gentle interval to avoid overloading

/** DBT-44: 8 inputs (1–4 Analog, 5–8 Dante), 8 outputs (1–4 Analog, 5–8 Dante) */
const NUM_INPUTS = 8
const NUM_OUTPUTS = 8

class SynqDbt44Instance extends InstanceBase {
	constructor(internal) {
		super(internal)
		this.receiveBuffer = Buffer.alloc(0)
		this.syncState = {}
		this.syncVariableDefs = []
		this.syncTimer = null
		/** Saved gain per matrix point (input_output) when muted to -120, for restore on toggle */
		this.savedMatrixGain = {}
	}

	/** Build OSC path: /<path>/<device_name> per DBT-44 API */
	oscPath(pathWithoutName) {
		const name = (this.config.device_name || '').trim()
		if (!name) return null
		const base = pathWithoutName.startsWith('/') ? pathWithoutName : `/${pathWithoutName}`
		return `${base}/${name}`
	}

	async init(config) {
		this.config = config
		this.targetHost = null
		this.socket = null
		this.pingTimer = null

		if (!this.config.host || !this.config.targetPort || !this.config.feedbackPort) {
			this.log('warn', 'Host, target port and feedback port are required')
			this.updateStatus('bad_config')
			this.setupEmptyActionsVariables()
			return
		}
		if (!(this.config.device_name || '').trim()) {
			this.log('warn', 'Device name is required (see DBT-44 web interface or SYNQ Network Discovery Tool)')
			this.updateStatus('bad_config')
			this.setupEmptyActionsVariables()
			return
		}

		const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(this.config.host)
		if (isIp) {
			this.targetHost = this.config.host
			this.startConnection()
		} else {
			this.updateStatus('connecting')
			try {
				const addr = await dns.promises.lookup(this.config.host, { family: 4 })
				this.targetHost = addr.address
				this.log('info', `Resolved ${this.config.host} to ${this.targetHost}`)
				this.startConnection()
			} catch (err) {
				this.log('error', `Cannot resolve hostname ${this.config.host}: ${err.message}`)
				this.updateStatus('connection_failure')
				this.setupEmptyActionsVariables()
			}
		}
	}

	startConnection() {
		if (this.socket) {
			try {
				this.socket.close()
			} catch (_) {}
			this.socket = null
		}

		this.updateStatus('connecting')
		this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
		this.receiveBuffer = Buffer.alloc(0)

		this.socket.on('error', (err) => {
			this.log('warn', `Socket error: ${err.message}`)
			this.updateStatus('connection_failure')
		})

		this.socket.on('message', (msg, rinfo) => {
			this.log('debug', `Received UDP ${msg.length} bytes from ${rinfo.address}:${rinfo.port}`)
			this.updateStatus('ok', (this.config.device_name || '').trim() || 'Connected')
			this.receiveBuffer = Buffer.concat([this.receiveBuffer, msg])
			this.parseOscIncoming()
		})

		this.socket.bind({ address: '0.0.0.0', port: this.config.feedbackPort }, () => {
			this.log('info', `Listening for OSC on port ${this.config.feedbackPort}`)
			this.updateActions()
			this.updateFeedbacks()
			this.updateVariables()
			this.setVariableValues({ device_name: (this.config.device_name || '').trim() })
			this.updateStatus('ok', (this.config.device_name || '').trim() || 'Ready')
			setTimeout(() => this.sendSync(), 1000)
		})
	}

	/** Convert OSC path to variable id. Path may end with /<device_name> or not. */
	pathToVariableId(path) {
		if (!path || typeof path !== 'string') return null
		const name = (this.config.device_name || '').trim()
		let withoutName = path
		if (name && path.endsWith('/' + name)) {
			withoutName = path.slice(0, path.length - name.length - 1)
		}
		return withoutName.replace(/^\//, '').replace(/\//g, '_')
	}

	/** Channel 1–4 = Analog 1–4, 5–8 = Dante 1–4. Returns e.g. "Analog in 2", "Dante out 1". */
	channelLabel(chNum, type) {
		const n = parseInt(chNum, 10) || 1
		const kind = n <= 4 ? 'Analog' : 'Dante'
		const num = n <= 4 ? n : n - 4
		const inOut = type === 'input' ? 'in' : 'out'
		return `${kind} ${inOut} ${num}`
	}

	/** Human-readable name for a sync variable */
	variableIdToName(variableId) {
		try {
			if (typeof variableId !== 'string' || !variableId) return variableId || '?'
		} catch (_) {
			return '?'
		}
		try {
			const parts = variableId.split('_')
			const first = parts[0]
			if (first === 'gain' && parts[1] === 'input' && parts[2] !== undefined && parts[3] !== undefined) {
				return `Gain: ${this.channelLabel(parts[2], 'input')} -> ${this.channelLabel(parts[3], 'output')}`
			}
			if (first === 'gain' && parts[1] === 'output' && parts[2] !== undefined) {
				return `Gain: ${this.channelLabel(parts[2], 'output')}`
			}
			if (first === 'mute' && parts[1] === 'input' && parts[2] !== undefined) {
				return `Mute: ${this.channelLabel(parts[2], 'input')}`
			}
			if (first === 'mute' && parts[1] === 'output' && parts[2] !== undefined) {
				return `Mute: ${this.channelLabel(parts[2], 'output')}`
			}
			if (first === 'trim' && parts[1] !== undefined) {
				return `Trim: ${this.channelLabel(parts[1], 'input')}`
			}
			if (first === 'delay' && parts[1] !== undefined) {
				return `Delay: ${this.channelLabel(parts[1], 'output')}`
			}
			if (first === 'phase' && parts[1] === 'input' && parts[2] !== undefined) {
				return `Phase: ${this.channelLabel(parts[2], 'input')}`
			}
			if (first === 'phase' && parts[1] === 'output' && parts[2] !== undefined) {
				return `Phase: ${this.channelLabel(parts[2], 'output')}`
			}
			if (first === 'eqenable' && parts[1] === 'input' && parts[2] !== undefined) {
				return `EQ enable: ${this.channelLabel(parts[2], 'input')}`
			}
			if (first === 'eqenable' && parts[1] === 'output' && parts[2] !== undefined) {
				return `EQ enable: ${this.channelLabel(parts[2], 'output')}`
			}
			if (first === 'comp' && parts[1] !== undefined && parts[2] === 'input' && parts[3] !== undefined) {
				const sub = parts[1].charAt(0).toUpperCase() + parts[1].slice(1)
				return `Comp ${sub}: ${this.channelLabel(parts[3], 'input')}`
			}
			if (first === 'comp' && parts[1] !== undefined && parts[2] === 'output' && parts[3] !== undefined) {
				const sub = parts[1].charAt(0).toUpperCase() + parts[1].slice(1)
				return `Comp ${sub}: ${this.channelLabel(parts[3], 'output')}`
			}
			if (first === 'eq' && parts[1] === 'gain' && parts[2] === 'input' && parts[3] !== undefined) {
				const pt = parts[4] !== undefined ? ` (pt ${parts[4]})` : ''
				return `EQ gain: ${this.channelLabel(parts[3], 'input')}${pt}`
			}
			if (first === 'eq' && parts[1] === 'gain' && parts[2] === 'output' && parts[3] !== undefined) {
				const pt = parts[4] !== undefined ? ` (pt ${parts[4]})` : ''
				return `EQ gain: ${this.channelLabel(parts[3], 'output')}${pt}`
			}
			return variableId.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
		} catch (err) {
			this.log('debug', `variableIdToName error for "${variableId}": ${err.message}`)
			return typeof variableId === 'string' ? variableId.replace(/_/g, ' ') : '?'
		}
	}

	/** Format a value for display: booleans/integers as '1'/'0', other numbers with one decimal. */
	formatSyncValue(value) {
		if (value === true) return '1'
		if (value === false) return '0'
		const num = Number(value)
		if (Number.isFinite(num)) {
			if (num === 0 || num === 1) return String(num)
			const rounded = Math.round(num * 10) / 10
			return rounded.toFixed(1)
		}
		return String(value)
	}

	/** Store one sync value (call applySyncVariables after a batch) */
	storeSyncValue(variableId, value) {
		if (!variableId) return
		this.syncState[variableId] = this.formatSyncValue(value)
		if (!this.syncVariableDefs.some((d) => d.variableId === variableId)) {
			this.syncVariableDefs.push({ variableId, name: this.variableIdToName(variableId) })
		}
	}

	applySyncVariables() {
		try {
			const deviceName = (this.config.device_name || '').trim()
			const defs = [
				{ variableId: 'device_name', name: 'Device name (configured)' },
				...this.syncVariableDefs.map((d) => ({
					variableId: d.variableId,
					name: this.variableIdToName(d.variableId),
				})),
			]
			this.setVariableDefinitions(defs)
			this.setVariableValues({ device_name: deviceName, ...this.syncState })
		} catch (err) {
			this.log('warn', `applySyncVariables error: ${err.message}`)
		}
	}

	sendSync() {
		const path = this.oscPath(OSC_PATH_SYNC)
		if (!path || !this.targetHost || !this.socket) return
		try {
			const msg = osc.writePacket({ address: path, args: [] }, { metadata: true })
			this.socket.send(msg, 0, msg.length, this.config.targetPort, this.targetHost, (err) => {
				if (err) this.log('warn', `Sync send error: ${err.message}`)
				else this.log('debug', `Sent ${path}`)
			})
		} catch (err) {
			this.log('warn', `Failed to send sync: ${err.message}`)
		}
	}

	/** Send OSC message with args to the device */
	sendOsc(pathWithoutName, args) {
		const path = this.oscPath(pathWithoutName)
		if (!path || !this.targetHost) return
		const oscArgs = args || []
		this.oscSend(this.targetHost, this.config.targetPort, path, oscArgs)
		const argStr = oscArgs.map((a) => (a.type === 'T' ? 1 : a.type === 'F' ? 0 : a.value)).join(', ')
		this.log('debug', `Sent ${path} [${argStr}]`)
	}

	getCompleteMessageLength(buffer) {
		try {
			const packet = osc.readPacket(buffer, {})
			return osc.writePacket(packet).length
		} catch (_) {
			return buffer.length + 1
		}
	}

	/** DBT-44 sends path-only OSC (no type tag, no args) */
	parsePathOnlyOsc(buffer) {
		if (buffer.length < 2 || buffer[0] !== 0x2f) return null
		const nullIdx = buffer.indexOf(0)
		if (nullIdx < 1) return null
		const path = buffer.toString('utf8', 0, nullIdx)
		if (!/^\/[\x20-\x7e]+$/.test(path)) return null
		const byteLength = (nullIdx + 1 + 3) & ~3
		if (byteLength > buffer.length) return null
		return { path, byteLength }
	}

	parseOscIncoming() {
		let hadSyncMessage = false
		while (this.receiveBuffer.length > 0) {
			let messageLength = this.getCompleteMessageLength(this.receiveBuffer)
			let message = null
			let packet = null

			if (messageLength <= this.receiveBuffer.length) {
				message = this.receiveBuffer.slice(0, messageLength)
				try {
					packet = osc.readPacket(message, { metadata: true })
				} catch (_) {
					packet = null
				}
			}

			if (!packet && this.receiveBuffer.length >= 4) {
				const pathOnly = this.parsePathOnlyOsc(this.receiveBuffer)
				if (pathOnly) {
					messageLength = pathOnly.byteLength
					message = this.receiveBuffer.slice(0, messageLength)
					packet = { address: pathOnly.path, args: [] }
					this.log('debug', `OSC (path-only) ${pathOnly.path}`)
				}
			}

			if (messageLength > this.receiveBuffer.length) break

			message = message || this.receiveBuffer.slice(0, messageLength)
			this.receiveBuffer = this.receiveBuffer.slice(messageLength)

			if (packet) {
				if (packet.address) {
					hadSyncMessage = this.handleOscMessage(packet) || hadSyncMessage
				} else if (packet.packets) {
					this.log('debug', `OSC bundle with ${packet.packets.length} messages`)
					for (const p of packet.packets) {
						if (p.address) hadSyncMessage = this.handleOscMessage(p) || hadSyncMessage
					}
				}
			} else if (message.length <= 64) {
				this.log('debug', `OSC unparsed (${message.length} bytes): ${message.toString('hex')}`)
			}
		}
		if (hadSyncMessage) this.applySyncVariables()
	}

	handleOscMessage(packet) {
		const path = packet.address
		const args = packet.args || []

		this.updateStatus('ok', (this.config.device_name || '').trim() || 'Connected')

		const variableId = this.pathToVariableId(path)
		const pingPath = this.oscPath('/ping')
		const isPing = path === '/ping' || (!!pingPath && path === pingPath)
		const willStore = variableId && !isPing
		if (variableId) {
			this.log('debug', `OSC ${path} args=${args.length} -> var ${variableId} store=${willStore}`)
		} else {
			this.log('debug', `OSC ${path} args=${args.length} (no variableId)`)
		}

		if (willStore) {
			const value =
				args.length > 0
					? args[0].type === 'T'
						? true
						: args[0].type === 'F'
							? false
							: args[0].value
					: ''
			this.storeSyncValue(variableId, value)
			this.checkFeedbacks()
			return true
		}
		this.checkFeedbacks()
		return false
	}

	sendPing() {
		const path = this.oscPath(OSC_PATH_PING)
		if (!path || !this.targetHost || !this.socket) return
		try {
			const msg = osc.writePacket({ address: path, args: [] }, { metadata: true })
			this.socket.send(msg, 0, msg.length, this.config.targetPort, this.targetHost, (err) => {
				if (err) this.log('warn', `Send error: ${err.message}`)
				else this.log('debug', `Sent ${path}`)
			})
		} catch (err) {
			this.log('warn', `Failed to send ping: ${err.message}`)
		}
	}

	setupEmptyActionsVariables() {
		this.updateActions()
		this.updateFeedbacks()
		this.updateVariables()
	}

	async destroy() {
		if (this.pingTimer) {
			clearInterval(this.pingTimer)
			this.pingTimer = null
		}
		if (this.syncTimer) {
			clearInterval(this.syncTimer)
			this.syncTimer = null
		}
		if (this.socket) {
			try {
				this.socket.close()
			} catch (_) {}
			this.socket = null
		}
		this.log('debug', 'destroy')
	}

	async configUpdated(config) {
		this.config = config
		if (this.socket) {
			try {
				this.socket.close()
			} catch (_) {}
			this.socket = null
		}
		if (this.pingTimer) {
			clearInterval(this.pingTimer)
			this.pingTimer = null
		}
		if (this.syncTimer) {
			clearInterval(this.syncTimer)
			this.syncTimer = null
		}
		this.syncState = {}
		this.syncVariableDefs = []
		this.savedMatrixGain = {}
		this.targetHost = null
		if (
			this.config.host &&
			this.config.targetPort &&
			this.config.feedbackPort &&
			(this.config.device_name || '').trim()
		) {
			const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(this.config.host)
			if (isIp) {
				this.targetHost = this.config.host
				this.startConnection()
			} else {
				this.updateStatus('connecting')
				try {
					const addr = await dns.promises.lookup(this.config.host, { family: 4 })
					this.targetHost = addr.address
					this.startConnection()
				} catch (err) {
					this.log('error', `Cannot resolve hostname: ${err.message}`)
					this.updateStatus('connection_failure')
				}
			}
		} else {
			this.updateStatus('bad_config')
		}
	}

	getConfigFields() {
		return [
			{
				type: 'textinput',
				id: 'host',
				label: 'DBT-44 IP or hostname',
				width: 8,
				regex: Regex.HOSTNAME,
				required: true,
			},
			{
				type: 'textinput',
				id: 'device_name',
				label: 'Device name',
				width: 8,
				default: '',
				required: true,
				tooltip:
					'Name/identifier of this unit (each OSC URL ends with /<device_name>). Find it in the DBT-44 web interface or SYNQ Network Discovery Tool.',
			},
			{
				type: 'textinput',
				id: 'targetPort',
				label: 'OSC target port (device receives)',
				width: 4,
				regex: Regex.PORT,
				default: '9000',
				required: true,
			},
			{
				type: 'textinput',
				id: 'feedbackPort',
				label: 'OSC feedback port (Companion receives)',
				width: 4,
				regex: Regex.PORT,
				default: '9001',
				required: true,
			},
		]
	}

	updateActions() {
		UpdateActions(this)
	}

	updateFeedbacks() {
		UpdateFeedbacks(this)
	}

	updateVariables() {
		UpdateVariables(this)
	}
}

runEntrypoint(SynqDbt44Instance, UpgradeScripts)
