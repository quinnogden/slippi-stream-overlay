/**
 * Every address a phone or tablet could open the control panel on.
 *
 * The venue hands out a different IP than home does, so the URL is printed at
 * startup instead of written down.
 */

const os = require("os");

/** Tailscale's CGNAT range, 100.64.0.0/10. */
const isTailscale = (ip) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);

/**
 * @param {{ BRIDGE_PORT: number }} config
 * @returns {string[]} one console-ready line per reachable address
 *
 * Tailscale addresses sort first: they don't change with the network and tunnel
 * through the client isolation that most guest Wi-Fi runs, which plain LAN
 * addresses can't.
 */
function lanControlUrls(config) {
  const addrs = [];

  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    // Hyper-V/WSL switches and Bluetooth PAN are never reachable from a phone.
    if (/vEthernet|VirtualBox|VMware|Bluetooth|Loopback/i.test(name)) continue;
    for (const net of list ?? []) {
      if (net.internal) continue;
      if (net.family !== "IPv4" && net.family !== 4) continue;
      // 169.254/16 is a disconnected adapter's self-assigned address.
      if (net.address.startsWith("169.254.")) continue;
      addrs.push({ name, address: net.address });
    }
  }

  addrs.sort((a, b) => Number(isTailscale(b.address)) - Number(isTailscale(a.address)));
  return addrs.map((a) => `http://${a.address}:${config.BRIDGE_PORT}/control  (${a.name})`);
}

module.exports = { lanControlUrls };
