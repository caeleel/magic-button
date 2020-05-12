// From https://base64.guru/developers/javascript/examples/polyfill

const ascii = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
const indices: {[key: string]: number} = {}
for (var c = 0; c < ascii.length; c++) {
  const chr = ascii[c];
  indices[chr] = c;
}

export function base64encode(data: Uint8Array) {
  let len = data.length - 1
  let i = -1
  let b64 = ''

  while (i < len) {
    var code = data[++i] << 16 | data[++i] << 8 | data[++i];
    b64 += ascii[(code >>> 18) & 63] + ascii[(code >>> 12) & 63] + ascii[(code >>> 6) & 63] + ascii[code & 63];
  }

  var pads = data.length % 3;
  if (pads > 0) {
    b64 = b64.slice(0, pads - 3);

    while (b64.length % 4 !== 0) {
      b64 += '=';
    }
  }

  return b64
}