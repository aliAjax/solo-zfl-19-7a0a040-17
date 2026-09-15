const http = require("http");
const { createApp } = require("./src/app");

const PORT = Number(process.env.PORT || 3019);

const { handler } = createApp();

const server = http.createServer(handler);

server.listen(PORT, () => {
  console.log(`Organ strip punch API running at http://127.0.0.1:${PORT}`);
});
