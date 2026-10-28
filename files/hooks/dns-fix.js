const dns = require('dns');

const origLookup = dns.lookup.bind(dns);

// Dynamically map www.codebuddy.ai / codebuddy.ai through Tencent EdgeOne's live api.codebuddy.ai CNAME
// so public DNS sinkholes (0.0.0.1 / ENOENT) never break CodeBuddy Intl on any machine or OS.
dns.lookup = function patchedLookup(hostname, options, callback) {
  let cb = callback;
  let opts = options;
  if (typeof options === 'function') {
    cb = options;
    opts = {};
  }
  if (hostname === 'www.codebuddy.ai' || hostname === 'codebuddy.ai') {
    return origLookup('api.codebuddy.ai', opts, cb);
  }
  return origLookup(hostname, opts, cb);
};
