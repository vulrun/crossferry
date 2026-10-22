import dns from "node:dns";
import { isPrivateAddress } from "@crossferry/shared";

// A dns.lookup replacement that refuses private results. Handed to undici's Agent as the
// connect-time lookup, so the socket goes to exactly the address that was checked here;
// a DNS record cannot be swapped between check and connect.
export function createSafeLookup(baseLookup = dns.lookup) {
  return function safeLookup(hostname, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }

    baseLookup(hostname, options, (err, address, family) => {
      if (err) return callback(err);

      // with { all: true } the result is an array of { address, family }
      const results = Array.isArray(address) ? address : [{ address, family }];
      const blocked = results.find((entry) => isPrivateAddress(entry.address));
      if (blocked) {
        const error = new Error(`Blocked private address ${blocked.address} for ${hostname}`);
        error.code = "EBLOCKED";
        return callback(error);
      }

      callback(null, address, family);
    });
  };
}

export const safeLookup = createSafeLookup();
