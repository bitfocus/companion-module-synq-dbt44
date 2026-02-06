/**
 * Send /sync to DBT-44 and dump the response format.
 * Uses port 9002 so you can run this while Companion (9001) is running.
 * Usage: node scripts/sync-capture.js <host> <device_name>
 * Example: node scripts/sync-capture.js 192.168.1.100 dbt44-device
 */
const dgram = require('dgram');
const osc = require('osc');

const host = process.argv[2];
const deviceName = process.argv[3];

if (!host || !deviceName) {
	console.error('Usage: node scripts/sync-capture.js <host> <device_name>');
	console.error('Example: node scripts/sync-capture.js 192.168.1.100 dbt44-device');
	process.exit(1);
}
const targetPort = 9000;
const listenPort = 9002; // use 9002 so Companion can keep using 9001

let buffer = Buffer.alloc(0);
let receivedCount = 0;

function getCompleteMessageLength(buf) {
	try {
		const packet = osc.readPacket(buf, {});
		return osc.writePacket(packet).length;
	} catch (_) {
		return buf.length + 1;
	}
}

function parseAndLog(buf) {
	while (buf.length > 0) {
		const len = getCompleteMessageLength(buf);
		if (len > buf.length) break;
		const msg = buf.slice(0, len);
		buf = buf.slice(len);
		try {
			const packet = osc.readPacket(msg, { metadata: true });
			if (packet.address) {
				const args = (packet.args || []).map((a) => (a.type ? `[${a.type}]${a.value}` : a)).join(', ');
				console.log(`${packet.address}  ${args}`);
			} else if (packet.packets) {
				console.log(`(bundle with ${packet.packets.length} messages)`);
				packet.packets.forEach((p) => {
					if (p.address) {
						const args = (p.args || []).map((a) => (a.type ? `[${a.type}]${a.value}` : a)).join(', ');
						console.log(`  ${p.address}  ${args}`);
					}
				});
			}
		} catch (e) {
			console.log('(parse error)', e.message, 'hex:', msg.slice(0, Math.min(48, msg.length)).toString('hex'));
		}
	}
	return buf;
}

const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
socket.on('message', (msg, rinfo) => {
	receivedCount++;
	console.log(`\n--- Received #${receivedCount}: ${msg.length} bytes from ${rinfo.address}:${rinfo.port} ---`);
	buffer = Buffer.concat([buffer, msg]);
	buffer = parseAndLog(buffer);
});
socket.on('error', (err) => console.error('Socket error:', err.message));

socket.bind({ address: '0.0.0.0', port: listenPort }, () => {
	const addr = socket.address();
	console.log(`Listening on ${addr.address}:${addr.port}`);
	console.log(`Target: ${host}:${targetPort}  device: ${deviceName}\n`);

	function send(path) {
		const packet = osc.writePacket({ address: path, args: [] }, { metadata: true });
		socket.send(packet, 0, packet.length, targetPort, host, (err) => {
			if (err) return console.error('Send error:', err.message);
			console.log(`Sent ${path}`);
		});
	}

	// Send /ping first in case device expects it
	send(`/ping/${deviceName}`);
	setTimeout(() => {
		send(`/sync/${deviceName}`);
		console.log('Waiting 10s for response...\n');
	}, 500);

	setTimeout(() => {
		if (receivedCount === 0) {
			console.log('No UDP response received. Check: device IP, firewall (incoming UDP), and that device name matches.');
		} else {
			console.log(`\nDone. Received ${receivedCount} packet(s).`);
		}
		socket.close();
		process.exit(0);
	}, 10000);
});
