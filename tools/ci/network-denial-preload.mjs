// @ts-nocheck

/**
 * Node.js preload module for complete runtime network denial during render and qualification tests.
 * Disables net, tls, http, https, http2, dgram, dns, global fetch, and global WebSocket.
 */

import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import dgram from "node:dgram";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";

function deny(operation) {
  throw new Error(`[NETWORK_DENIED] Runtime network access is strictly prohibited: ${operation}`);
}

// 1. net
net.Socket.prototype.connect = function () {
  deny("net.Socket.connect");
};
net.connect = function () {
  deny("net.connect");
};
net.createConnection = function () {
  deny("net.createConnection");
};

// 2. tls
tls.TLSSocket.prototype.connect = function () {
  deny("tls.TLSSocket.connect");
};
tls.connect = function () {
  deny("tls.connect");
};

// 3. http & https
http.request = function () {
  deny("http.request");
};
http.get = function () {
  deny("http.get");
};
https.request = function () {
  deny("https.request");
};
https.get = function () {
  deny("https.get");
};

// 4. http2
if (http2 && http2.connect) {
  http2.connect = function () {
    deny("http2.connect");
  };
}

// 5. dgram
dgram.Socket.prototype.send = function () {
  deny("dgram.Socket.send");
};
dgram.Socket.prototype.connect = function () {
  deny("dgram.Socket.connect");
};

// 6. dns
dns.lookup = function () {
  deny("dns.lookup");
};
dns.resolve = function () {
  deny("dns.resolve");
};
dns.resolve4 = function () {
  deny("dns.resolve4");
};
dns.resolve6 = function () {
  deny("dns.resolve6");
};
dnsPromises.lookup = async function () {
  deny("dnsPromises.lookup");
};
dnsPromises.resolve = async function () {
  deny("dnsPromises.resolve");
};

// 7. global fetch & WebSocket
if (typeof globalThis.fetch === "function") {
  globalThis.fetch = async function () {
    deny("globalThis.fetch");
  };
}

if (typeof globalThis.WebSocket === "function") {
  globalThis.WebSocket = /** @type {any} */ (function () {
    deny("globalThis.WebSocket");
  });
}
