const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

const routes = require("./routes");
const errorHandler = require("./middleware/errorHandler");

const app = express();

app.use(helmet());
app.use(cors()); // tighten this to your Flutter web origin(s) before production
app.use(morgan("dev"));
app.use(express.json());

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.use("/api", routes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ message: "Route not found" });
});

app.use(errorHandler);

module.exports = app;
