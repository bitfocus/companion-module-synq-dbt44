const NUM_INPUTS = 8
const NUM_OUTPUTS = 8

module.exports = function (self) {
	const inputChoices = Array.from({ length: NUM_INPUTS }, (_, i) => {
		const n = i + 1
		const num = n <= 4 ? n : n - 4
		const type = n <= 4 ? 'Analog in' : 'Dante in'
		return { id: n, label: `${type} ${num}` }
	})
	const outputChoices = Array.from({ length: NUM_OUTPUTS }, (_, i) => {
		const n = i + 1
		const num = n <= 4 ? n : n - 4
		const type = n <= 4 ? 'Analog out' : 'Dante out'
		return { id: n, label: `${type} ${num}` }
	})

	self.setActionDefinitions({
		refresh_sync: {
			name: 'Refresh sync (get all settings from device)',
			options: [],
			callback: () => {
				self.sendSync()
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
				const inIdx = parseInt(action.options.input, 10) || 1
				const outIdx = parseInt(action.options.output, 10) || 1
				const path = `/gain/input/${inIdx}/${outIdx}`
				const value = Number(action.options.gain)
				self.sendOsc(path, [{ type: 'f', value }])
				const key = `gain_input_${inIdx}_${outIdx}`
				self.storeSyncValue(key, value)
				self.applySyncVariables()
				self.checkFeedbacks('matrix_point_muted')
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
				const outIdx = parseInt(action.options.output, 10) || 1
				const path = `/gain/output/${outIdx}`
				const value = Number(action.options.gain)
				self.sendOsc(path, [{ type: 'f', value }])
				const key = `gain_output_${outIdx}`
				self.storeSyncValue(key, value)
				self.applySyncVariables()
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
				const inIdx = parseInt(action.options.input, 10) || 1
				const outIdx = parseInt(action.options.output, 10) || 1
				const key = `gain_input_${inIdx}_${outIdx}`
				const current = parseFloat(self.syncState[key]) || 0
				const preset = action.options.step_preset
				const step = preset === 'custom' ? Number(action.options.step_custom) || 0 : Number(preset) || 0
				const value = Math.max(-120, Math.min(10, current + step))
				const path = `/gain/input/${inIdx}/${outIdx}`
				self.sendOsc(path, [{ type: 'f', value }])
				self.storeSyncValue(key, value)
				self.applySyncVariables()
				self.checkFeedbacks('matrix_point_muted')
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
				const outIdx = parseInt(action.options.output, 10) || 1
				const key = `gain_output_${outIdx}`
				const current = parseFloat(self.syncState[key]) || 0
				const preset = action.options.step_preset
				const step = preset === 'custom' ? Number(action.options.step_custom) || 0 : Number(preset) || 0
				const value = Math.max(-120, Math.min(10, current + step))
				const path = `/gain/output/${outIdx}`
				self.sendOsc(path, [{ type: 'f', value }])
				self.storeSyncValue(key, value)
				self.applySyncVariables()
			},
		},
		matrix_point_mute_toggle: {
			name: 'Matrix point mute (toggle)',
			options: [
				{ type: 'dropdown', id: 'input', label: 'Input', default: 1, choices: inputChoices },
				{ type: 'dropdown', id: 'output', label: 'Output', default: 1, choices: outputChoices },
			],
			callback: (action) => {
				const inIdx = parseInt(action.options.input, 10) || 1
				const outIdx = parseInt(action.options.output, 10) || 1
				const key = `gain_input_${inIdx}_${outIdx}`
				const savedKey = `${inIdx}_${outIdx}`
				const current = parseFloat(self.syncState[key])
				const isMuted = !isNaN(current) && current <= -120
				if (isMuted) {
					const restore = self.savedMatrixGain[savedKey] != null ? Number(self.savedMatrixGain[savedKey]) : 0
					delete self.savedMatrixGain[savedKey]
					const path = `/gain/input/${inIdx}/${outIdx}`
					self.sendOsc(path, [{ type: 'f', value: restore }])
					self.storeSyncValue(key, restore)
				} else {
					self.savedMatrixGain[savedKey] = isNaN(current) ? 0 : current
					const path = `/gain/input/${inIdx}/${outIdx}`
					self.sendOsc(path, [{ type: 'f', value: -120 }])
					self.storeSyncValue(key, -120)
				}
				self.applySyncVariables()
				self.checkFeedbacks('matrix_point_muted')
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
				const inIdx = parseInt(action.options.input, 10) || 1
				const path = `/mute/input/${inIdx}`
				let mute = action.options.mute === true || action.options.mute === 'true'
				if (action.options.mute === 'toggle') {
					const v = self.syncState[`mute_input_${inIdx}`]
					const num = parseFloat(v)
					const isMuted = !isNaN(num) ? num !== 0 : v === '1' || v === 1 || v === true || v === 'true'
					mute = !isMuted
				}
				self.sendOsc(path, [mute ? { type: 'T' } : { type: 'F' }])
				self.storeSyncValue(`mute_input_${inIdx}`, mute ? 1 : 0)
				self.applySyncVariables()
				self.checkFeedbacks('input_muted')
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
				const outIdx = parseInt(action.options.output, 10) || 1
				const path = `/mute/output/${outIdx}`
				let mute = action.options.mute === true || action.options.mute === 'true'
				if (action.options.mute === 'toggle') {
					const v = self.syncState[`mute_output_${outIdx}`]
					const num = parseFloat(v)
					const isMuted = !isNaN(num) ? num !== 0 : v === '1' || v === 1 || v === true || v === 'true'
					mute = !isMuted
				}
				self.sendOsc(path, [mute ? { type: 'T' } : { type: 'F' }])
				self.storeSyncValue(`mute_output_${outIdx}`, mute ? 1 : 0)
				self.applySyncVariables()
				self.checkFeedbacks('output_muted')
			},
		},
	})
}
