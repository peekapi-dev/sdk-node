# @api-usage-dashboard/sdk-node

Node.js SDK for API Usage Dashboard. Add API analytics to your Express app with one line of code.

## Installation

```bash
npm install @api-usage-dashboard/sdk-node
```

## Quick Start

```javascript
const express = require("express");
const { apiDash } = require("@api-usage-dashboard/sdk-node");

const app = express();

// Add API analytics — one line
app.use(apiDash({ apiKey: "ak_live_xxx" }));

app.get("/api/users", (req, res) => {
  res.json({ users: [] });
});

app.listen(3001);
```

## Configuration

```javascript
app.use(
  apiDash({
    // Required
    apiKey: "ak_live_xxx",

    // Optional
    endpoint: "https://your-dashboard.com/api/ingest", // Ingestion URL
    flushInterval: 10000, // Flush every 10s (default)
    batchSize: 100, // Flush at 100 events (default)
    debug: false, // Log SDK activity

    // Custom consumer identification
    identifyConsumer: (req) => req.headers["x-client-id"],
  }),
);
```

## How It Works

1. The middleware intercepts every request/response
2. Captures: method, path, status code, response time, sizes
3. Batches events and sends them asynchronously to the dashboard
4. Zero performance impact — async, non-blocking, <1ms overhead

## What Gets Tracked

| Field              | Description                   |
| ------------------ | ----------------------------- |
| `method`           | HTTP method (GET, POST, etc.) |
| `path`             | Route path                    |
| `status_code`      | Response status code          |
| `response_time_ms` | Time to respond in ms         |
| `request_size`     | Request body size in bytes    |
| `response_size`    | Response body size in bytes   |
| `consumer_id`      | API consumer identifier       |
| `timestamp`        | ISO 8601 timestamp            |
