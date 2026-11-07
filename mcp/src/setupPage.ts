/** GET /setup: the pairing form (worker.ts). It posts to /setup; the reply is the JSON outcome. */
export const SETUP_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>YAOS MCP setup</title>
<style>
	:root { color-scheme: light dark; }
	body { font: 16px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 2rem auto; padding: 0 1rem; }
	label { display: block; margin-top: 1rem; font-weight: 600; }
	input[type=text], input[type=password], input[type=url] { width: 100%; padding: .5rem; font: inherit; box-sizing: border-box; }
	button { margin-top: 1.5rem; padding: .6rem 1.2rem; font: inherit; }
	p.note { color: GrayText; font-size: .9rem; }
</style>
</head>
<body>
<h1>Pair the YAOS MCP</h1>
<p class="note">On a paired device, open YAOS settings and choose <b>Pair another device</b> (or use <b>Pair a device</b> in the server console), then enter the code here. The code works once and expires after 15 minutes.</p>
<form method="post" action="/setup">
	<label for="server">YAOS server URL</label>
	<input id="server" name="server" type="url" placeholder="https://yaos.example.workers.dev" required>
	<label for="code">Pairing code</label>
	<input id="code" name="code" type="text" autocomplete="one-time-code" required>
	<label for="name">Device name</label>
	<input id="name" name="name" type="text" value="MCP">
	<label for="token">MCP token (the MCP_TOKEN secret of this Worker)</label>
	<input id="token" name="token" type="password" required>
	<label><input name="replace" type="checkbox"> Replace the vault already paired</label>
	<button type="submit">Pair</button>
</form>
</body>
</html>
`;
