const express = require("express");
const cors = require("cors");

const app = express();
const PORT = 8080;

app.use(cors());
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({ ok: true });
});

app.get("/", (_req, res) => {
    res.json({ ok: true });
  });
  
  app.post("/ingest", (_req, res) => {
    res.json({ ok: true, data: _req.body });
  });
  
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
