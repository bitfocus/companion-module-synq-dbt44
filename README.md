# companion-module-synq-dbt44

Bitfocus Companion module for the **Synq DBT-44** Dante audio bridge. Control mute status and input/output gain via OSC.

Based on the Synq DBI/DBT OSC protocol. See [synq-audio.com/dbt-44](https://synq-audio.com/dbt-44) for more information.

## Connection

- Protocol: UDP. Device receives on port **9000**, device sends on port **9001**.
- The module sends `/ping/<device_name>` periodically. When the device echoes back (or sends any OSC), status shows **OK**.
- All OSC paths use the form `/<path>/<device_name>` per the DBT-44 API.

### Network Limitation

**Important:** Due to the DBT-44's OSC implementation, **feedback from the device only works on a local network** (same subnet). Feedback does not work through a router. 

- ✅ **Controlling the device works through a router**—you can send commands (mute, gain changes, etc.).
- ❌ **Feedback does not work through a router**—you will not receive status updates, variable values, or feedback states.

For full functionality including feedback (button states, variable updates), ensure Companion and the DBT-44 are on the same local network/subnet.

## Development

- `yarn` – install dependencies  
- `yarn build` – build for development  
- Save files in the module folder; Companion will reload the module when files change.

## References

- [Synq DBT-44](https://synq-audio.com/dbt-44) - Official product information
