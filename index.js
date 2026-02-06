const { InstanceBase, Regex, runEntrypoint } = require('@companion-module/base');
const dgram = require('dgram');
const osc = require('osc');

/**
 * DBT-44 OSC protocol:
 * - UDP, device receives on port 9000, device sends (responses) on port 9001.
 * - Every URL must end with /<device_name> (identifier set on the unit, e.g. from web interface).
 * - /ping sends back the same command to test if device is on the network.
 * - /sync returns all current settings from the device (OSC messages, often in a bundle).
 * - Sending a URL without a parameter value = "get", device returns current state.
 * See https://synq-audio.com/dbt-44 for more information.
 */
const OSC_PATH_PING = '/ping';
const OSC_PATH_SYNC = '/sync';
const SYNC_INTERVAL_MS = 60000; // gentle interval to avoid overloading

/** DBT-44: 8 inputs (1–4 Analog, 5–8 Dante), 8 outputs (1–4 Analog, 5–8 Dante) */
const NUM_INPUTS = 8;
const NUM_OUTPUTS = 8;

class SynqDbt44Instance extends InstanceBase {
	constructor(internal) {
		super(internal);
		this.receiveBuffer = Buffer.alloc(0);
		this.syncState = {};
		this.syncVariableDefs = [];
		this.syncTimer = null;
		/** Saved gain per matrix point (input_output) when muted to -120, for restore on toggle */
		this.savedMatrixGain = {};
	}

	/** Build OSC path: /<path>/<device_name> per DBT-44 API */
	oscPath(pathWithoutName) {
		const name = (this.config.device_name || '').trim();
		if (!name) return null;
		const base = pathWithoutName.startsWith('/') ? pathWithoutName : `/${pathWithoutName}`;
		return `${base}/${name}`;
	}

	async init(config) {
		this.config = config;
		this.targetHost = null;
		this.socket = null;
		this.pingTimer = null;

		if (!this.config.host || !this.config.targetPort || !this.config.feedbackPort) {
			this.log('warn', 'Host, target port and feedback port are required');
			this.updateStatus('bad_config');
			this.setupEmptyActionsVariables();
			return;
		}
		if (!(this.config.device_name || '').trim()) {
			this.log('warn', 'Device name is required (see DBT-44 web interface or SYNQ Network Discovery Tool)');
			this.updateStatus('bad_config');
			this.setupEmptyActionsVariables();
			return;
		}

		const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(this.config.host);
		if (isIp) {
			this.targetHost = this.config.host;
			this.startConnection();
		} else {
			this.updateStatus('connecting');
			try {
				const { lookup } = require('dns').promises;
				const addr = await lookup(this.config.host, { family: 4 });
				this.targetHost = addr.address;
				this.log('info', `Resolved ${this.config.host} to ${this.targetHost}`);
				this.startConnection();
			} catch (err) {
				this.log('error', `Cannot resolve hostname ${this.config.host}: ${err.message}`);
				this.updateStatus('connection_failure');
				this.setupEmptyActionsVariables();
			}
		}
	}

	startConnection() {
		if (this.socket) {
			try {
				this.socket.close();
			} catch (_) {}
			this.socket = null;
		}

		this.updateStatus('connecting');
		this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
		this.receiveBuffer = Buffer.alloc(0);

		this.socket.on('error', (err) => {
			this.log('warn', `Socket error: ${err.message}`);
			this.updateStatus('connection_failure');
		});

		this.socket.on('message', (msg, rinfo) => {
			this.log('debug', `Received UDP ${msg.length} bytes from ${rinfo.address}:${rinfo.port}`);
			// Any reply from the device (e.g. ping echo) means we're connected
			this.updateStatus('ok', (this.config.device_name || '').trim() || 'Connected');
			this.receiveBuffer = Buffer.concat([this.receiveBuffer, msg]);
			this.parseOscIncoming();
		});

		this.socket.bind({ address: '0.0.0.0', port: this.config.feedbackPort }, () => {
			this.log('info', `Listening for OSC on port ${this.config.feedbackPort}`);
			this.updateActions();
			this.updateFeedbacks();
			this.updateVariables();
			this.setVariableValues({ device_name: (this.config.device_name || '').trim() });
			this.updateStatus('ok', (this.config.device_name || '').trim() || 'Ready');
			// Sync once on load only — device keeps OSC state, no periodic sync
			setTimeout(() => this.sendSync(), 1000);
		});
	}

	/** Convert OSC path to variable id. Path may end with /<device_name> or not. */
	pathToVariableId(path) {
		if (!path || typeof path !== 'string') return null;
		const name = (this.config.device_name || '').trim();
		let withoutName = path;
		if (name && path.endsWith('/' + name)) {
			withoutName = path.slice(0, path.length - name.length - 1);
		}
		return withoutName.replace(/^\//, '').replace(/\//g, '_');
	}

	/** Channel 1–4 = Analog 1–4, 5–8 = Dante 1–4. Returns e.g. "Analog in 2", "Dante out 1". */
	channelLabel(chNum, type) {
		const n = parseInt(chNum, 10) || 1;
		const kind = n <= 4 ? 'Analog' : 'Dante';
		const num = n <= 4 ? n : n - 4;
		const inOut = type === 'input' ? 'in' : 'out';
		return `${kind} ${inOut} ${num}`;
	}

	/** Human-readable name for a sync variable (e.g. gain_input_2_5 -> "Gain: Analog in 2 -> Dante out 1"). */
	variableIdToName(variableId) {
		try {
			if (typeof variableId !== 'string' || !variableId) return variableId || '?';
		} catch (_) {
			return '?';
		}
		try {
			const parts = variableId.split('_');
		const first = parts[0];
		if (first === 'gain' && parts[1] === 'input' && parts[2] !== undefined && parts[3] !== undefined) {
			return `Gain: ${this.channelLabel(parts[2], 'input')} -> ${this.channelLabel(parts[3], 'output')}`;
		}
		if (first === 'gain' && parts[1] === 'output' && parts[2] !== undefined) {
			return `Gain: ${this.channelLabel(parts[2], 'output')}`;
		}
		if (first === 'mute' && parts[1] === 'input' && parts[2] !== undefined) {
			return `Mute: ${this.channelLabel(parts[2], 'input')}`;
		}
		if (first === 'mute' && parts[1] === 'output' && parts[2] !== undefined) {
			return `Mute: ${this.channelLabel(parts[2], 'output')}`;
		}
		if (first === 'trim' && parts[1] !== undefined) {
			return `Trim: ${this.channelLabel(parts[1], 'input')}`;
		}
		if (first === 'delay' && parts[1] !== undefined) {
			return `Delay: ${this.channelLabel(parts[1], 'output')}`;
		}
		if (first === 'phase' && parts[1] === 'input' && parts[2] !== undefined) {
			return `Phase: ${this.channelLabel(parts[2], 'input')}`;
		}
		if (first === 'phase' && parts[1] === 'output' && parts[2] !== undefined) {
			return `Phase: ${this.channelLabel(parts[2], 'output')}`;
		}
		if (first === 'eqenable' && parts[1] === 'input' && parts[2] !== undefined) {
			return `EQ enable: ${this.channelLabel(parts[2], 'input')}`;
		}
		if (first === 'eqenable' && parts[1] === 'output' && parts[2] !== undefined) {
			return `EQ enable: ${this.channelLabel(parts[2], 'output')}`;
		}
		// comp/enable, comp/threshold, etc. — input or output + index
		if (first === 'comp' && parts[1] !== undefined && parts[2] === 'input' && parts[3] !== undefined) {
			const sub = parts[1].charAt(0).toUpperCase() + parts[1].slice(1);
			return `Comp ${sub}: ${this.channelLabel(parts[3], 'input')}`;
		}
		if (first === 'comp' && parts[1] !== undefined && parts[2] === 'output' && parts[3] !== undefined) {
			const sub = parts[1].charAt(0).toUpperCase() + parts[1].slice(1);
			return `Comp ${sub}: ${this.channelLabel(parts[3], 'output')}`;
		}
		// eq/gain/input/X/Y or eq/gain/output/X/Y
		if (first === 'eq' && parts[1] === 'gain' && parts[2] === 'input' && parts[3] !== undefined) {
			const pt = parts[4] !== undefined ? ` (pt ${parts[4]})` : '';
			return `EQ gain: ${this.channelLabel(parts[3], 'input')}${pt}`;
		}
		if (first === 'eq' && parts[1] === 'gain' && parts[2] === 'output' && parts[3] !== undefined) {
			const pt = parts[4] !== undefined ? ` (pt ${parts[4]})` : '';
			return `EQ gain: ${this.channelLabel(parts[3], 'output')}${pt}`;
		}
		// Fallback: readable title from variableId
		return variableId.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
		} catch (err) {
			this.log('debug', `variableIdToName error for "${variableId}": ${err.message}`);
			return typeof variableId === 'string' ? variableId.replace(/_/g, ' ') : '?';
		}
	}

	/** Format a value for display: booleans/integers as '1'/'0', other numbers with one decimal. */
	formatSyncValue(value) {
		if (value === true) return '1';
		if (value === false) return '0';
		const num = Number(value);
		if (Number.isFinite(num)) {
			// Boolean-like integers (0 or 1) should be stored as '0' or '1', not '0.0' or '1.0'
			if (num === 0 || num === 1) {
				return String(num);
			}
			// Other numbers: one decimal place
			const rounded = Math.round(num * 10) / 10;
			return rounded.toFixed(1);
		}
		return String(value);
	}

	/** Store one sync value (call applySyncVariables after a batch) */
	storeSyncValue(variableId, value) {
		if (!variableId) return;
		this.syncState[variableId] = this.formatSyncValue(value);
		if (!this.syncVariableDefs.some((d) => d.variableId === variableId)) {
			this.syncVariableDefs.push({ variableId, name: this.variableIdToName(variableId) });
		}
	}

	applySyncVariables() {
		try {
			const deviceName = (this.config.device_name || '').trim();
			const defs = [
				{ variableId: 'device_name', name: 'Device name (configured)' },
				...this.syncVariableDefs.map((d) => ({
					variableId: d.variableId,
					name: this.variableIdToName(d.variableId),
				})),
			];
			this.setVariableDefinitions(defs);
			this.setVariableValues({ device_name: deviceName, ...this.syncState });
		} catch (err) {
			this.log('warn', `applySyncVariables error: ${err.message}`);
		}
	}

	sendSync() {
		const path = this.oscPath(OSC_PATH_SYNC);
		if (!path || !this.targetHost || !this.socket) return;
		try {
			const msg = osc.writePacket({ address: path, args: [] }, { metadata: true });
			this.socket.send(msg, 0, msg.length, this.config.targetPort, this.targetHost, (err) => {
				if (err) this.log('warn', `Sync send error: ${err.message}`);
				else this.log('debug', `Sent ${path}`);
			});
		} catch (err) {
			this.log('warn', `Failed to send sync: ${err.message}`);
		}
	}

	/** Send OSC message with args to the device (path without device name suffix). Uses Companion's oscSend so encoding matches the generic OSC module. */
	sendOsc(pathWithoutName, args) {
		const path = this.oscPath(pathWithoutName);
		if (!path || !this.targetHost) return;
		const oscArgs = args || [];
		this.oscSend(this.targetHost, this.config.targetPort, path, oscArgs);
		const argStr = oscArgs.map((a) => (a.type === 'T' ? 1 : a.type === 'F' ? 0 : a.value)).join(', ');
		this.log('debug', `Sent ${path} [${argStr}]`);
	}

	getCompleteMessageLength(buffer) {
		try {
			const packet = osc.readPacket(buffer, {});
			return osc.writePacket(packet).length;
		} catch (_) {
			return buffer.length + 1;
		}
	}

	/**
	 * DBT-44 sends path-only OSC (no type tag, no args) - e.g. 20 bytes for /ping/device-name.
	 * Parse that and return { path, byteLength } or null.
	 */
	parsePathOnlyOsc(buffer) {
		if (buffer.length < 2 || buffer[0] !== 0x2f) return null; // must start with '/'
		const nullIdx = buffer.indexOf(0);
		if (nullIdx < 1) return null;
		const path = buffer.toString('utf8', 0, nullIdx);
		if (!/^\/[\x20-\x7e]+$/.test(path)) return null; // printable path
		// OSC pads to 4-byte boundary
		const byteLength = (nullIdx + 1 + 3) & ~3;
		if (byteLength > buffer.length) return null;
		return { path, byteLength };
	}

	parseOscIncoming() {
		let hadSyncMessage = false;
		while (this.receiveBuffer.length > 0) {
			let messageLength = this.getCompleteMessageLength(this.receiveBuffer);
			let message = null;
			let packet = null;

			if (messageLength <= this.receiveBuffer.length) {
				message = this.receiveBuffer.slice(0, messageLength);
				try {
					packet = osc.readPacket(message, { metadata: true });
				} catch (_) {
					packet = null;
				}
			}

			// Fallback: DBT-44 may send path-only (no type tag) - e.g. 20-byte /ping echo
			if (!packet && this.receiveBuffer.length >= 4) {
				const pathOnly = this.parsePathOnlyOsc(this.receiveBuffer);
				if (pathOnly) {
					messageLength = pathOnly.byteLength;
					message = this.receiveBuffer.slice(0, messageLength);
					packet = { address: pathOnly.path, args: [] };
					this.log('debug', `OSC (path-only) ${pathOnly.path}`);
				}
			}

			if (messageLength > this.receiveBuffer.length) break;

			message = message || this.receiveBuffer.slice(0, messageLength);
			this.receiveBuffer = this.receiveBuffer.slice(messageLength);

			if (packet) {
				if (packet.address) {
					hadSyncMessage = this.handleOscMessage(packet) || hadSyncMessage;
				} else if (packet.packets) {
					this.log('debug', `OSC bundle with ${packet.packets.length} messages`);
					for (const p of packet.packets) {
						if (p.address) hadSyncMessage = this.handleOscMessage(p) || hadSyncMessage;
					}
				}
			} else if (message.length <= 64) {
				this.log('debug', `OSC unparsed (${message.length} bytes): ${message.toString('hex')}`);
			}
		}
		if (hadSyncMessage) this.applySyncVariables();
	}

	/** Returns true if this was a sync-style message we stored */
	handleOscMessage(packet) {
		const path = packet.address;
		const args = packet.args || [];

		this.updateStatus('ok', (this.config.device_name || '').trim() || 'Connected');

		// Store /sync-style messages: path with optional /<device_name>; value is first arg or empty
		const variableId = this.pathToVariableId(path);
		// Skip /ping - don't create a variable for it
		const pingPath = this.oscPath('/ping');
		const isPing = path === '/ping' || (!!pingPath && path === pingPath);
		const willStore = variableId && !isPing;
		if (variableId) {
			this.log('debug', `OSC ${path} args=${args.length} -> var ${variableId} store=${willStore}`);
		} else {
			this.log('debug', `OSC ${path} args=${args.length} (no variableId)`);
		}

		if (willStore) {
			const value =
				args.length > 0
					? args[0].type === 'T'
						? true
						: args[0].type === 'F'
							? false
							: args[0].value
					: '';
			this.storeSyncValue(variableId, value);
			this.checkFeedbacks();
			return true;
		}
		this.checkFeedbacks();
		return false;
	}

	sendPing() {
		const path = this.oscPath(OSC_PATH_PING);
		if (!path || !this.targetHost || !this.socket) return;
		try {
			const msg = osc.writePacket({ address: path, args: [] }, { metadata: true });
			this.socket.send(msg, 0, msg.length, this.config.targetPort, this.targetHost, (err) => {
				if (err) this.log('warn', `Send error: ${err.message}`);
				else this.log('debug', `Sent ${path}`);
			});
		} catch (err) {
			this.log('warn', `Failed to send ping: ${err.message}`);
		}
	}

	setupEmptyActionsVariables() {
		this.updateActions();
		this.updateFeedbacks();
		this.updateVariables();
	}

	async destroy() {
		if (this.pingTimer) {
			clearInterval(this.pingTimer);
			this.pingTimer = null;
		}
		if (this.syncTimer) {
			clearInterval(this.syncTimer);
			this.syncTimer = null;
		}
		if (this.socket) {
			try {
				this.socket.close();
			} catch (_) {}
			this.socket = null;
		}
		this.log('debug', 'destroy');
	}

	async configUpdated(config) {
		this.config = config;
		if (this.socket) {
			try {
				this.socket.close();
			} catch (_) {}
			this.socket = null;
		}
		if (this.pingTimer) {
			clearInterval(this.pingTimer);
			this.pingTimer = null;
		}
		if (this.syncTimer) {
			clearInterval(this.syncTimer);
			this.syncTimer = null;
		}
		this.syncState = {};
		this.syncVariableDefs = [];
		this.savedMatrixGain = {};
		this.targetHost = null;
		if (
			this.config.host &&
			this.config.targetPort &&
			this.config.feedbackPort &&
			(this.config.device_name || '').trim()
		) {
			const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(this.config.host);
			if (isIp) {
				this.targetHost = this.config.host;
				this.startConnection();
			} else {
				this.updateStatus('connecting');
				try {
					const { lookup } = require('dns').promises;
					const addr = await lookup(this.config.host, { family: 4 });
					this.targetHost = addr.address;
					this.startConnection();
				} catch (err) {
					this.log('error', `Cannot resolve hostname: ${err.message}`);
					this.updateStatus('connection_failure');
				}
			}
		} else {
			this.updateStatus('bad_config');
		}
	}

	/** 64 presets in 8 folders (one per output). Each folder "Out N" has 8 buttons "In 1"…"In 8" with gain value; one page per output. */
	getPresetDefinitions() {
		const presets = {};
		const instanceId = this.id || 'instance';
		for (let outNum = 1; outNum <= NUM_OUTPUTS; outNum++) {
			const category = `Out ${outNum}`;
			for (let inNum = 1; inNum <= NUM_INPUTS; inNum++) {
				const id = `matrix_mute_in${inNum}_out${outNum}`;
				const varId = `gain_input_${inNum}_${outNum}`;
				presets[id] = {
					type: 'button',
					category,
					name: `In ${inNum}`,
					style: {
						text: `In ${inNum}\n$(${instanceId}:${varId})`,
						size: '18',
						color: 0xffffff,
						bgcolor: 0x000000,
					},
					feedbacks: [
						{
							feedbackId: 'matrix_point_muted',
							options: { input: inNum, output: outNum },
							style: {
								bgcolor: 0xff0000,
								text: `In ${inNum}\nMUTE`,
								color: 0xffffff,
							},
						},
					],
					steps: [
						{
							down: [
								{
									actionId: 'matrix_point_mute_toggle',
									options: { input: inNum, output: outNum },
								},
							],
							up: [],
						},
					],
				};
			}
		}
		return presets;
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
		];
	}

	updateActions() {
		// DBT-44: 1–4 Analog in/out, 5–8 Dante in/out (each numbered 1–4 within type)
		const inputChoices = Array.from({ length: NUM_INPUTS }, (_, i) => {
			const n = i + 1;
			const num = n <= 4 ? n : n - 4;
			const type = n <= 4 ? 'Analog in' : 'Dante in';
			return { id: n, label: `${type} ${num}` };
		});
		const outputChoices = Array.from({ length: NUM_OUTPUTS }, (_, i) => {
			const n = i + 1;
			const num = n <= 4 ? n : n - 4;
			const type = n <= 4 ? 'Analog out' : 'Dante out';
			return { id: n, label: `${type} ${num}` };
		});

		this.setPresetDefinitions(this.getPresetDefinitions());
		this.setActionDefinitions({
			refresh_sync: {
				name: 'Refresh sync (get all settings from device)',
				options: [],
				callback: () => {
					this.sendSync();
				},
			},
			set_input_gain: {
				name: 'Set input gain (matrix)',
				options: [
					{ type: 'dropdown', id: 'input', label: 'Input', default: 1, choices: inputChoices },
					{ type: 'dropdown', id: 'output', label: 'Output', default: 1, choices: outputChoices },
					{
						type: 'number',
						id: 'gain',
						label: 'Gain (dB)',
						default: 0,
						min: -120,
						max: 10,
						step: 0.5,
						range: true,
					},
				],
				callback: (action) => {
					const inIdx = parseInt(action.options.input, 10) || 1;
					const outIdx = parseInt(action.options.output, 10) || 1;
					const path = `/gain/input/${inIdx}/${outIdx}`;
					const value = Number(action.options.gain);
					this.sendOsc(path, [{ type: 'f', value }]);
					const key = `gain_input_${inIdx}_${outIdx}`;
					this.storeSyncValue(key, value);
					this.applySyncVariables();
					this.checkFeedbacks();
				},
			},
			set_output_gain: {
				name: 'Set output gain',
				options: [
					{ type: 'dropdown', id: 'output', label: 'Output', default: 1, choices: outputChoices },
					{
						type: 'number',
						id: 'gain',
						label: 'Gain (dB)',
						default: 0,
						min: -120,
						max: 10,
						step: 0.5,
						range: true,
					},
				],
				callback: (action) => {
					const outIdx = parseInt(action.options.output, 10) || 1;
					const path = `/gain/output/${outIdx}`;
					const value = Number(action.options.gain);
					this.sendOsc(path, [{ type: 'f', value }]);
					const key = `gain_output_${outIdx}`;
					this.storeSyncValue(key, value);
					this.applySyncVariables();
					this.checkFeedbacks();
				},
			},
			step_input_gain: {
				name: 'Step input gain (matrix)',
				options: [
					{ type: 'dropdown', id: 'input', label: 'Input', default: 1, choices: inputChoices },
					{ type: 'dropdown', id: 'output', label: 'Output', default: 1, choices: outputChoices },
					{
						type: 'dropdown',
						id: 'step_preset',
						label: 'Step',
						default: '3',
						choices: [
							{ id: '3', label: '+3 dB' },
							{ id: '-3', label: '-3 dB' },
							{ id: 'custom', label: 'Custom amount' },
						],
					},
					{
						type: 'number',
						id: 'step_custom',
						label: 'Custom step (dB)',
						default: 3,
						min: -120,
						max: 120,
						step: 0.5,
						tooltip: 'Used when Step is "Custom amount". Positive = add dB, negative = subtract dB.',
						isVisible: (options) => options.step_preset === 'custom',
					},
				],
				callback: (action) => {
					const inIdx = parseInt(action.options.input, 10) || 1;
					const outIdx = parseInt(action.options.output, 10) || 1;
					const key = `gain_input_${inIdx}_${outIdx}`;
					const current = parseFloat(this.syncState[key]) || 0;
					const preset = action.options.step_preset;
					const step = preset === 'custom' ? Number(action.options.step_custom) || 0 : Number(preset) || 0;
					const value = Math.max(-120, Math.min(10, current + step));
					const path = `/gain/input/${inIdx}/${outIdx}`;
					this.sendOsc(path, [{ type: 'f', value }]);
					this.storeSyncValue(key, value);
					this.applySyncVariables();
					this.checkFeedbacks();
				},
			},
			step_output_gain: {
				name: 'Step output gain',
				options: [
					{ type: 'dropdown', id: 'output', label: 'Output', default: 1, choices: outputChoices },
					{
						type: 'dropdown',
						id: 'step_preset',
						label: 'Step',
						default: '3',
						choices: [
							{ id: '3', label: '+3 dB' },
							{ id: '-3', label: '-3 dB' },
							{ id: 'custom', label: 'Custom amount' },
						],
					},
					{
						type: 'number',
						id: 'step_custom',
						label: 'Custom step (dB)',
						default: 3,
						min: -120,
						max: 120,
						step: 0.5,
						tooltip: 'Used when Step is "Custom amount". Positive = add dB, negative = subtract dB.',
						isVisible: (options) => options.step_preset === 'custom',
					},
				],
				callback: (action) => {
					const outIdx = parseInt(action.options.output, 10) || 1;
					const key = `gain_output_${outIdx}`;
					const current = parseFloat(this.syncState[key]) || 0;
					const preset = action.options.step_preset;
					const step = preset === 'custom' ? Number(action.options.step_custom) || 0 : Number(preset) || 0;
					const value = Math.max(-120, Math.min(10, current + step));
					const path = `/gain/output/${outIdx}`;
					this.sendOsc(path, [{ type: 'f', value }]);
					this.storeSyncValue(key, value);
					this.applySyncVariables();
					this.checkFeedbacks();
				},
			},
			matrix_point_mute_toggle: {
				name: 'Matrix point mute (toggle)',
				options: [
					{ type: 'dropdown', id: 'input', label: 'Input', default: 1, choices: inputChoices },
					{ type: 'dropdown', id: 'output', label: 'Output', default: 1, choices: outputChoices },
				],
				callback: (action) => {
					const inIdx = parseInt(action.options.input, 10) || 1;
					const outIdx = parseInt(action.options.output, 10) || 1;
					const key = `gain_input_${inIdx}_${outIdx}`;
					const savedKey = `${inIdx}_${outIdx}`;
					const current = parseFloat(this.syncState[key]);
					const isMuted = !isNaN(current) && current <= -120;
					if (isMuted) {
						const restore = this.savedMatrixGain[savedKey] != null ? Number(this.savedMatrixGain[savedKey]) : 0;
						delete this.savedMatrixGain[savedKey];
						const path = `/gain/input/${inIdx}/${outIdx}`;
						this.sendOsc(path, [{ type: 'f', value: restore }]);
						this.storeSyncValue(key, restore);
					} else {
						this.savedMatrixGain[savedKey] = isNaN(current) ? 0 : current;
						const path = `/gain/input/${inIdx}/${outIdx}`;
						this.sendOsc(path, [{ type: 'f', value: -120 }]);
						this.storeSyncValue(key, -120);
					}
					this.applySyncVariables();
					this.checkFeedbacks();
				},
			},
			set_input_mute: {
				name: 'Set input mute',
				options: [
					{ type: 'dropdown', id: 'input', label: 'Input', default: 1, choices: inputChoices },
					{
						type: 'dropdown',
						id: 'mute',
						label: 'Mute',
						default: false,
						choices: [
							{ id: false, label: 'Unmute' },
							{ id: true, label: 'Mute' },
							{ id: 'toggle', label: 'Toggle' },
						],
					},
				],
				callback: (action) => {
					const inIdx = parseInt(action.options.input, 10) || 1;
					const path = `/mute/input/${inIdx}`;
					let mute = action.options.mute === true || action.options.mute === 'true';
					if (action.options.mute === 'toggle') {
						const v = this.syncState[`mute_input_${inIdx}`];
						// Handle formatted values like '1.0', '0.0', '1', '0', true, 1, etc.
						const num = parseFloat(v);
						const isMuted = !isNaN(num) ? num !== 0 : (v === '1' || v === 1 || v === true || v === 'true');
						mute = !isMuted;
					}
					this.sendOsc(path, [mute ? { type: 'T' } : { type: 'F' }]);
					this.storeSyncValue(`mute_input_${inIdx}`, mute ? 1 : 0);
					this.applySyncVariables();
					this.checkFeedbacks('input_muted', 'output_muted');
				},
			},
			set_output_mute: {
				name: 'Set output mute',
				options: [
					{ type: 'dropdown', id: 'output', label: 'Output', default: 1, choices: outputChoices },
					{
						type: 'dropdown',
						id: 'mute',
						label: 'Mute',
						default: false,
						choices: [
							{ id: false, label: 'Unmute' },
							{ id: true, label: 'Mute' },
							{ id: 'toggle', label: 'Toggle' },
						],
					},
				],
				callback: (action) => {
					const outIdx = parseInt(action.options.output, 10) || 1;
					const path = `/mute/output/${outIdx}`;
					let mute = action.options.mute === true || action.options.mute === 'true';
					if (action.options.mute === 'toggle') {
						const v = this.syncState[`mute_output_${outIdx}`];
						// Handle formatted values like '1.0', '0.0', '1', '0', true, 1, etc.
						const num = parseFloat(v);
						const isMuted = !isNaN(num) ? num !== 0 : (v === '1' || v === 1 || v === true || v === 'true');
						mute = !isMuted;
					}
					this.sendOsc(path, [mute ? { type: 'T' } : { type: 'F' }]);
					this.storeSyncValue(`mute_output_${outIdx}`, mute ? 1 : 0);
					this.applySyncVariables();
					this.checkFeedbacks('input_muted', 'output_muted');
				},
			},
		});
	}

	updateFeedbacks() {
		const inputChoices = Array.from({ length: NUM_INPUTS }, (_, i) => {
			const n = i + 1;
			const num = n <= 4 ? n : n - 4;
			const type = n <= 4 ? 'Analog in' : 'Dante in';
			return { id: n, label: `${type} ${num}` };
		});
		const outputChoices = Array.from({ length: NUM_OUTPUTS }, (_, i) => {
			const n = i + 1;
			const num = n <= 4 ? n : n - 4;
			const type = n <= 4 ? 'Analog out' : 'Dante out';
			return { id: n, label: `${type} ${num}` };
		});

		this.setFeedbackDefinitions({
			input_muted: {
				type: 'boolean',
				name: 'Input muted',
				description: 'True when the selected input is muted',
				options: [
					{ type: 'dropdown', id: 'input', label: 'Input', default: 1, choices: inputChoices },
				],
				defaultStyle: {
					bgcolor: 0xff0000,
					color: 0xffffff,
					text: 'MUTED',
				},
				callback: (feedback) => {
					const inIdx = parseInt(feedback.options.input, 10) || 1;
					const v = this.syncState[`mute_input_${inIdx}`];
					// Handle formatted values like '1.0', '0.0', '1', '0', true, 1, etc.
					const num = parseFloat(v);
					return !isNaN(num) ? num !== 0 : (v === '1' || v === 1 || v === true || v === 'true');
				},
			},
			output_muted: {
				type: 'boolean',
				name: 'Output muted',
				description: 'True when the selected output is muted',
				options: [
					{ type: 'dropdown', id: 'output', label: 'Output', default: 1, choices: outputChoices },
				],
				defaultStyle: {
					bgcolor: 0xff0000,
					color: 0xffffff,
					text: 'MUTED',
				},
				callback: (feedback) => {
					const outIdx = parseInt(feedback.options.output, 10) || 1;
					const v = this.syncState[`mute_output_${outIdx}`];
					// Handle formatted values like '1.0', '0.0', '1', '0', true, 1, etc.
					const num = parseFloat(v);
					return !isNaN(num) ? num !== 0 : (v === '1' || v === 1 || v === true || v === 'true');
				},
			},
			matrix_point_muted: {
				type: 'boolean',
				name: 'Matrix point muted (gain at -120)',
				description:
					'True when this matrix point (input → output) gain is at -120. Use with the variable for that point: show variable for level, this feedback for red background and "MUTE" when muted. Font size 18pt is applied when this feedback is active.',
				options: [
					{ type: 'dropdown', id: 'input', label: 'Input', default: 1, choices: inputChoices },
					{ type: 'dropdown', id: 'output', label: 'Output', default: 1, choices: outputChoices },
				],
				defaultStyle: {
					bgcolor: 0xff0000,
					color: 0xffffff,
					text: 'MUTE',
					size: '18',
				},
				callback: (feedback) => {
					const inIdx = parseInt(feedback.options.input, 10) || 1;
					const outIdx = parseInt(feedback.options.output, 10) || 1;
					const v = this.syncState[`gain_input_${inIdx}_${outIdx}`];
					const num = parseFloat(v);
					return !isNaN(num) && num <= -120;
				},
			},
		});
	}

	updateVariables() {
		const defs = [
			{ variableId: 'device_name', name: 'Device name (configured)' },
			...this.syncVariableDefs.map((d) => ({ variableId: d.variableId, name: this.variableIdToName(d.variableId) })),
		];
		this.setVariableDefinitions(defs);
		const deviceName = (this.config.device_name || '').trim();
		this.setVariableValues({ device_name: deviceName, ...this.syncState });
	}
}

const UpgradeScripts = require('./upgrades.js');
runEntrypoint(SynqDbt44Instance, UpgradeScripts);
