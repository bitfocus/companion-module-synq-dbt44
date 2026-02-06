## Synq DBT-44

Control a Synq DBT-44 Dante audio bridge from Companion via OSC.

**⚠️ Important Network Limitation:**
Due to the DBT-44's OSC implementation, **feedback from the device only works on a local network** (same subnet). Feedback does not work through a router. **Controlling the device works through a router**—you can send commands—but you will not receive status updates, variable values, or feedback states when routed through a router. For full functionality including feedback, ensure Companion and the DBT-44 are on the same local network.

**Setup:**
- **Host:** DBT-44 IP or hostname (e.g. from SYNQ Network Discovery Tool).
- **Device name:** The unit’s name/identifier. Every OSC URL ends with `/<device_name>`. Find this in the DBT-44 web interface or in the SYNQ Network Discovery Tool (device list).
- **Target port:** 9000 (device receives OSC).
- **Feedback port:** 9001 (Companion listens for device responses).

The module sends `/ping/<device_name>` to test the connection; when the device replies, status shows OK.


For more information about the DBT-44, see [synq-audio.com/dbt-44](https://synq-audio.com/dbt-44).
