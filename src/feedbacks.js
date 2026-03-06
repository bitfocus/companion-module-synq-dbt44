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

	self.setFeedbackDefinitions({
		input_muted: {
			type: 'boolean',
			name: 'Input muted',
			description: 'True when the selected input is muted',
			options: [{ type: 'dropdown', id: 'input', label: 'Input', default: 1, choices: inputChoices }],
			defaultStyle: {
				bgcolor: 0xff0000,
				color: 0xffffff,
				text: 'MUTED',
			},
			callback: (feedback) => {
				const inIdx = parseInt(feedback.options.input, 10) || 1
				const v = self.syncState[`mute_input_${inIdx}`]
				const num = parseFloat(v)
				return !isNaN(num) ? num !== 0 : v === '1' || v === 1 || v === true || v === 'true'
			},
		},
		output_muted: {
			type: 'boolean',
			name: 'Output muted',
			description: 'True when the selected output is muted',
			options: [{ type: 'dropdown', id: 'output', label: 'Output', default: 1, choices: outputChoices }],
			defaultStyle: {
				bgcolor: 0xff0000,
				color: 0xffffff,
				text: 'MUTED',
			},
			callback: (feedback) => {
				const outIdx = parseInt(feedback.options.output, 10) || 1
				const v = self.syncState[`mute_output_${outIdx}`]
				const num = parseFloat(v)
				return !isNaN(num) ? num !== 0 : v === '1' || v === 1 || v === true || v === 'true'
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
				const inIdx = parseInt(feedback.options.input, 10) || 1
				const outIdx = parseInt(feedback.options.output, 10) || 1
				const v = self.syncState[`gain_input_${inIdx}_${outIdx}`]
				const num = parseFloat(v)
				return !isNaN(num) && num <= -120
			},
		},
	})
}
