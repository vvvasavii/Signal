import express from "express";

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "signal-api",
  });
});

app.listen(PORT, () => {
  console.log(`Signal API listening on port ${PORT}`);
});