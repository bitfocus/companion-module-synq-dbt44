module.exports = function (self) {
	const defs = [
		{ variableId: 'device_name', name: 'Device name (configured)' },
		...self.syncVariableDefs.map((d) => ({
			variableId: d.variableId,
			name: self.variableIdToName(d.variableId),
		})),
	]
	self.setVariableDefinitions(defs)
	const deviceName = (self.config.device_name || '').trim()
	self.setVariableValues({ device_name: deviceName, ...self.syncState })
}
