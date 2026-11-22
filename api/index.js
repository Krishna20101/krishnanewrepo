/* Vercel serverless entry — Express app ko function ke roop me export karo.
   Render par yahi app `node server.js` se chalta hai; Vercel par yeh wrapper. */
const server = require("../server.js");
server.initFirebase(); // serverless me main() nahi chalta — store yahin ready karo
module.exports = server.app;
