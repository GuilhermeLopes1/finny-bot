'use strict';

function handleHealthCheck(req, res) {
  res.json({
    status: 'ok',
    service: 'Allo API',
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
  });
}

module.exports = { handleHealthCheck };
