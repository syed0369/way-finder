import os
import math
import uuid
import networkx as nx
from flask import Flask, request, jsonify, render_template, send_from_directory

app = Flask(__name__)
UPLOAD_FOLDER = os.path.join(app.static_folder, "uploads")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
app.config["UPLOAD_FOLDER"] = UPLOAD_FOLDER

# In-memory "graph DB": one graph per uploaded plan, keyed by plan_id
GRAPHS = {}
# In-memory map of plan_id -> uploaded plan image URL (so the read-only
# viewer can render the same plan without re-uploading)
PLAN_IMAGES = {}


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/view/<plan_id>")
def view_plan(plan_id):
    """Read-only viewer: pick source/destination and get directions.
    This is the page the generated QR code links to."""
    if plan_id not in GRAPHS:
        return render_template("view.html", plan_id=plan_id, image_url=None, not_found=True)
    return render_template(
        "view.html",
        plan_id=plan_id,
        image_url=PLAN_IMAGES.get(plan_id),
        not_found=False,
    )


@app.route("/upload", methods=["POST"])
def upload_plan():
    if "plan" not in request.files:
        return jsonify({"error": "No file part"}), 400
    file = request.files["plan"]
    if file.filename == "":
        return jsonify({"error": "No selected file"}), 400

    ext = os.path.splitext(file.filename)[1]
    plan_id = str(uuid.uuid4())
    filename = f"{plan_id}{ext}"
    filepath = os.path.join(app.config["UPLOAD_FOLDER"], filename)
    file.save(filepath)

    G = nx.Graph()
    GRAPHS[plan_id] = G

    image_url = f"/static/uploads/{filename}"
    PLAN_IMAGES[plan_id] = image_url

    return jsonify({
        "plan_id": plan_id,
        "image_url": image_url
    })


@app.route("/plan/<plan_id>/node", methods=["POST"])
def add_node(plan_id):
    G = GRAPHS.get(plan_id)
    if G is None:
        return jsonify({"error": "Invalid plan_id"}), 404

    data = request.get_json()
    node_id = data.get("id") or str(uuid.uuid4())
    name = data.get("name", node_id)
    x = data.get("x")
    y = data.get("y")

    if x is None or y is None:
        return jsonify({"error": "x and y coordinates required"}), 400

    G.add_node(node_id, name=name, x=x, y=y)
    return jsonify({"id": node_id, "name": name, "x": x, "y": y})


@app.route("/plan/<plan_id>/edge", methods=["POST"])
def add_edge(plan_id):
    G = GRAPHS.get(plan_id)
    if G is None:
        return jsonify({"error": "Invalid plan_id"}), 404

    data = request.get_json()
    src = data.get("source")
    dst = data.get("target")

    if src not in G.nodes or dst not in G.nodes:
        return jsonify({"error": "Invalid source or target node"}), 400

    x1, y1 = G.nodes[src]["x"], G.nodes[src]["y"]
    x2, y2 = G.nodes[dst]["x"], G.nodes[dst]["y"]
    weight = math.dist((x1, y1), (x2, y2))

    G.add_edge(src, dst, weight=weight)
    return jsonify({"source": src, "target": dst, "weight": weight})


@app.route("/plan/<plan_id>/edge", methods=["DELETE"])
def delete_edge(plan_id):
    G = GRAPHS.get(plan_id)
    if G is None:
        return jsonify({"error": "Invalid plan_id"}), 404

    data = request.get_json()
    src = data.get("source")
    dst = data.get("target")

    if G.has_edge(src, dst):
        G.remove_edge(src, dst)
        return jsonify({"status": "deleted"})
    return jsonify({"error": "Edge not found"}), 404


@app.route("/plan/<plan_id>/graph", methods=["GET"])
def get_graph(plan_id):
    G = GRAPHS.get(plan_id)
    if G is None:
        return jsonify({"error": "Invalid plan_id"}), 404

    nodes = [{"id": n, **G.nodes[n]} for n in G.nodes]
    edges = [{"source": u, "target": v, "weight": G[u][v]["weight"]} for u, v in G.edges]
    return jsonify({"nodes": nodes, "edges": edges})


@app.route("/plan/<plan_id>/node/<node_id>", methods=["DELETE"])
def delete_node(plan_id, node_id):
    G = GRAPHS.get(plan_id)
    if G is None:
        return jsonify({"error": "Invalid plan_id"}), 404
    if node_id in G.nodes:
        G.remove_node(node_id)
        return jsonify({"status": "deleted"})
    return jsonify({"error": "Node not found"}), 404


def bearing(p1, p2):
    """Compass bearing in degrees from p1 to p2.
    Screen coords: x increases right (East), y increases downward (South).
    North = 0deg, East = 90deg, South = 180deg, West = 270deg (clockwise from North)."""
    dx = p2[0] - p1[0]
    dy = p2[1] - p1[1]
    # Convert to math angle then to compass bearing
    angle = math.degrees(math.atan2(dx, -dy))  # -dy because screen y is inverted vs map North
    return angle % 360


def bearing_to_compass(deg):
    dirs = ["North", "Northeast", "East", "Southeast", "South", "Southwest", "West", "Northwest"]
    idx = round(deg / 45) % 8
    return dirs[idx]


def turn_instruction(prev_bearing, curr_bearing):
    """Determine turn direction relative to previous heading.
    User starts facing North; at each step we compute the relative turn
    needed to face the new bearing."""
    diff = (curr_bearing - prev_bearing + 360) % 360

    if diff <= 15 or diff >= 345:
        return "Go straight"
    elif 15 < diff <= 135:
        return "Turn right"
    elif 135 < diff < 225:
        return "Turn around (U-turn)"
    elif 225 <= diff < 345:
        return "Turn left"
    return "Go straight"


def generate_directions(G, path):
    """Generate turn-by-turn directions. User assumed to start facing North."""
    steps = []
    current_heading = 0  # facing North initially

    for i in range(len(path) - 1):
        n1, n2 = path[i], path[i + 1]
        p1 = (G.nodes[n1]["x"], G.nodes[n1]["y"])
        p2 = (G.nodes[n2]["x"], G.nodes[n2]["y"])

        seg_bearing = bearing(p1, p2)
        dist = round(G[n1][n2]["weight"], 1)

        if i == 0:
            instruction = f"Face {bearing_to_compass(seg_bearing)} and go straight"
        else:
            turn = turn_instruction(current_heading, seg_bearing)
            instruction = turn

        steps.append({
            "from": G.nodes[n1]["name"],
            "to": G.nodes[n2]["name"],
            "instruction": instruction,
            "distance": dist,
            "direction_facing": bearing_to_compass(seg_bearing)
        })

        current_heading = seg_bearing

    return steps


@app.route("/plan/<plan_id>/path", methods=["GET"])
def shortest_path(plan_id):
    G = GRAPHS.get(plan_id)
    if G is None:
        return jsonify({"error": "Invalid plan_id"}), 404

    source = request.args.get("source")
    target = request.args.get("target")

    if source not in G.nodes or target not in G.nodes:
        return jsonify({"error": "Invalid source or target room"}), 400

    try:
        path = nx.shortest_path(G, source=source, target=target, weight="weight")
        total_distance = nx.shortest_path_length(G, source=source, target=target, weight="weight")
    except nx.NetworkXNoPath:
        return jsonify({"error": "No path exists between these rooms"}), 404

    directions = generate_directions(G, path)
    path_names = [G.nodes[n]["name"] for n in path]

    return jsonify({
        "path": path,
        "path_names": path_names,
        "total_distance": round(total_distance, 1),
        "directions": directions
    })


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000)
