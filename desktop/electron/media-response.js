'use strict';
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

// Chromium needs explicit byte-range responses to seek a custom-protocol video.
// Electron 33's net.fetch(file:) returns 200 without range/length headers.
function mediaResponse(file, range, method = 'GET') {
  let size;
  try { size = fs.statSync(file).size; }
  catch (error) {
    if (error.code === 'ENOENT') return new Response(null, { status: 404 });
    throw error;
  }
  const types = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
    '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo' };
  const headers = { 'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  let start = 0, end = size - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = String(Math.max(0, end - start + 1));
  const body = method === 'HEAD' || size === 0 ? null : Readable.toWeb(fs.createReadStream(file, { start, end }));
  return new Response(body, { status: range ? 206 : 200, headers });
}
module.exports = { mediaResponse };
