import express from "express";
import alertsRouter from "./routes/alerts.js";
import incidentsRouter from "./routes/incidents.js";

const app = express();

app.use(express.json());
app.use("/api/v1/alerts", alertsRouter);
app.use("/api/v1/incidents", incidentsRouter);

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "signal-api",
  });
});

export default app;
