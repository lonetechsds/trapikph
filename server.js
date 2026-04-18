const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory report store ──
const reports = new Map();
const REPORT_TTL = 2 * 60 * 60 * 1000; // 2 hours

const REPORT_TYPES = ['traffic', 'accident', 'flood', 'closure', 'police', 'hazard', 'construction'];

function cleanupReports() {
  const now = Date.now();
  for (const [id, r] of reports) {
    if (now - r.createdAt > REPORT_TTL || r.resolved) {
      reports.delete(id);
    }
  }
}
setInterval(cleanupReports, 60000);

// ── API Routes ──

// TomTom config (serves key to client without hardcoding in HTML)
app.get('/api/config', (req, res) => {
  res.json({
    tomtomKey: process.env.TOMTOM_API_KEY || '',
  });
});

// Get all active reports
app.get('/api/reports', (req, res) => {
  const active = [];
  const now = Date.now();
  for (const [id, r] of reports) {
    if (now - r.createdAt <= REPORT_TTL && !r.resolved) {
      active.push({
        id, type: r.type, lat: r.lat, lng: r.lng,
        description: r.description, severity: r.severity,
        upvotes: r.upvotes, createdAt: r.createdAt,
      });
    }
  }
  res.json(active);
});

// Create a report
app.post('/api/reports', (req, res) => {
  const { type, lat, lng, description, severity } = req.body;
  if (!type || !REPORT_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid type' });
  if (typeof lat !== 'number' || typeof lng !== 'number') return res.status(400).json({ error: 'Invalid coordinates' });

  const id = crypto.randomBytes(6).toString('hex');
  const report = {
    id, type,
    lat: Number(lat), lng: Number(lng),
    description: String(description || '').slice(0, 200),
    severity: ['low', 'moderate', 'heavy'].includes(severity) ? severity : 'moderate',
    upvotes: 1,
    upvoters: new Set(),
    resolved: false,
    createdAt: Date.now(),
  };
  reports.set(id, report);

  const broadcast = {
    id, type: report.type, lat: report.lat, lng: report.lng,
    description: report.description, severity: report.severity,
    upvotes: report.upvotes, createdAt: report.createdAt,
  };
  io.emit('report:new', broadcast);
  res.json(broadcast);
});

// Route proxy — forward to OSRM demo server to avoid CORS
app.get('/api/route', async (req, res) => {
  const { start, end } = req.query; // format: lng,lat
  if (!start || !end) return res.status(400).json({ error: 'Missing start or end' });

  // Validate coordinate format
  const coordPattern = /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/;
  if (!coordPattern.test(start) || !coordPattern.test(end)) {
    return res.status(400).json({ error: 'Invalid coordinate format' });
  }

  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${start};${end}?overview=full&geometries=geojson&alternatives=true&steps=true`;
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Routing service unavailable' });
  }
});

// Geocoding proxy — Nominatim
app.get('/api/geocode', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query' });

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&countrycodes=ph&limit=5&q=${encodeURIComponent(String(q).slice(0, 200))}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'TrapikPH/1.0 (lonetechsds@gmail.com)' }
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Geocoding service unavailable' });
  }
});

// Reverse geocode
app.get('/api/reverse', async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'Missing lat/lng' });

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'TrapikPH/1.0 (lonetechsds@gmail.com)' }
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Reverse geocoding unavailable' });
  }
});

// ── Socket.io ──
io.on('connection', (socket) => {

  // Send all active reports on connect
  const active = [];
  const now = Date.now();
  for (const [id, r] of reports) {
    if (now - r.createdAt <= REPORT_TTL && !r.resolved) {
      active.push({
        id, type: r.type, lat: r.lat, lng: r.lng,
        description: r.description, severity: r.severity,
        upvotes: r.upvotes, createdAt: r.createdAt,
      });
    }
  }
  socket.emit('reports:all', active);

  // Upvote a report (confirms it's still valid)
  socket.on('report:upvote', (reportId) => {
    const r = reports.get(reportId);
    if (!r || r.resolved) return;
    if (r.upvoters.has(socket.id)) return;
    r.upvoters.add(socket.id);
    r.upvotes++;
    io.emit('report:update', {
      id: r.id, upvotes: r.upvotes,
    });
  });

  // Mark report as resolved (crowd-sourced: enough downvotes or time)
  socket.on('report:resolve', (reportId) => {
    const r = reports.get(reportId);
    if (!r) return;
    r.resolved = true;
    io.emit('report:remove', reportId);
    reports.delete(reportId);
  });
});

// SPA fallback
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚦 TrapikPH running on port ${PORT}`);
});
