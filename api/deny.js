/* Raw source/data files ko Vercel static layer se chhupane ke liye 403. */
module.exports = function deny(req, res) {
  res.status(403).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: false, error: "FORBIDDEN", message: "This path is not public." }));
};
