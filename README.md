# Wayfinder — Indoor Route Planner

## Run
pip install -r requirements.txt
python app.py
Open http://localhost:5000

## Usage
1. Upload a floor plan image.
2. "Mark room" mode: click on plan, name each room (creates graph nodes).
3. "Connect rooms" mode: click two room nodes to link them (creates weighted edges, weight = pixel distance).
4. Select source/destination, click "Get directions".
5. Click "Share via QR" to get a QR code (required server ip for viewing on other devices) / link to a read-only viewer (`/view/<plan_id>`)
   where anyone can pick two rooms and get directions — no editing tools.

## How it works
- Each uploaded plan gets its own in-memory networkx graph (acts as the graph DB).
- Nodes = rooms (with name + x,y pixel coords). Edges = walkable connections, weighted by Euclidean distance.
- Shortest path via Dijkstra (nx.shortest_path, weight='weight').
- Directions: compass bearing computed per segment; turn instructions (left/right/straight/U-turn)
  derived from the change in bearing between consecutive segments, assuming user starts facing North.
- QR code is generated entirely client-side (vendored MIT-licensed encoder in
  static/js/qrcode-gen.js) — it just encodes the URL to /view/<plan_id>, no external service.

## Notes
- Data is in-memory only (resets on server restart). Swap GRAPHS/PLAN_IMAGES dicts for a
  persistent graph DB (e.g., Neo4j) by replacing the networkx calls in app.py.
- /view/<plan_id> works on any device that can reach the server (same network/host), since
  it's served by the same Flask app.
