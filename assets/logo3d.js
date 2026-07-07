/* Turn a flat logo SVG into an auto-spinning, orbit-able extruded 3D object.
   robust-v2: handles stroke-only marks (monoline) + gradient/url() fills (ascender)
   so every mark yields solid geometry, not a blank/mangled render. */
(function (g) {
  function vbSize(svg) {
    const m = svg.match(/viewBox="([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)"/);
    return m ? { w: +m[3], h: +m[4] } : { w: 200, h: 200 };
  }
  // Resolve a real fill colour. SVGLoader leaves path.color at its default when the
  // fill is a gradient reference (fill="url(#id)") -> we dig the gradient's first
  // stop-color out of the raw SVG so gradient-filled marks aren't rendered blank/white.
  function resolveFill(THREE, style, p, svgText) {
    const f = style && style.fill;
    if (typeof f === 'string' && f.indexOf('url(') === 0) {
      const idm = f.match(/url\(\s*#?([^)\s]+)\s*\)/);
      if (idm) {
        const re = new RegExp('id="' + idm[1] + '"[\\s\\S]*?stop-color="([^"]+)"');
        const sm = svgText.match(re);
        if (sm) { try { return new THREE.Color(sm[1]); } catch (e) {} }
      }
      return new THREE.Color('#6B4CA6');
    }
    return p.color ? p.color : new THREE.Color('#6B4CA6');
  }
  // Take a flat (z=0) stroke ribbon geometry from SVGLoader.pointsToStroke and turn it
  // into a closed solid prism of the given depth: front cap at z=0, back cap at z=-depth,
  // plus side walls along the ribbon's boundary edges. Yields a genuine 3D bar for
  // stroke-only marks instead of a paper-thin ribbon.
  function thicken(THREE, flat, depth) {
    flat = flat.index ? flat.toNonIndexed() : flat;
    const pos = flat.getAttribute('position');
    const N = pos.count;
    const out = [];
    const key = (x, y) => Math.round(x * 1000) + ',' + Math.round(y * 1000);
    const edgeKey = (a, b) => (a < b ? a + ';' + b : b + ';' + a);
    const edges = new Map();
    const zf = 0, zb = -depth;
    for (let i = 0; i < N; i += 3) {
      const ax = pos.getX(i), ay = pos.getY(i);
      const bx = pos.getX(i + 1), by = pos.getY(i + 1);
      const cx = pos.getX(i + 2), cy = pos.getY(i + 2);
      // front cap (original winding)
      out.push(ax, ay, zf, bx, by, zf, cx, cy, zf);
      // back cap (reversed winding so it faces outward)
      out.push(ax, ay, zb, cx, cy, zb, bx, by, zb);
      const ka = key(ax, ay), kb = key(bx, by), kc = key(cx, cy);
      [[ka, ay, ax, kb, by, bx], [kb, by, bx, kc, cy, cx], [kc, cy, cx, ka, ay, ax]]
        .forEach(function (e) {
          const k = edgeKey(e[0], e[3]);
          const rec = edges.get(k);
          if (rec) rec.n++;
          else edges.set(k, { n: 1, x1: e[2], y1: e[1], x2: e[5], y2: e[4] });
        });
    }
    // boundary edges (belong to exactly one triangle) -> side walls
    edges.forEach(function (e) {
      if (e.n !== 1) return;
      out.push(e.x1, e.y1, zf, e.x2, e.y2, zf, e.x2, e.y2, zb);
      out.push(e.x1, e.y1, zf, e.x2, e.y2, zb, e.x1, e.y1, zb);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
    geo.computeVertexNormals();
    return geo;
  }
  function init(canvas, svgText) {
    const THREE = g.THREE;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, logarithmicDepthBuffer: true });
    renderer.setPixelRatio(Math.min(g.devicePixelRatio || 1, 2));
    const scene = new THREE.Scene();
    const vb = vbSize(svgText);
    const depth = Math.max(6, 0.11 * Math.min(vb.w, vb.h));
    const data = new THREE.SVGLoader().parse(svgText);
    const grp = new THREE.Group();
    const zStep = Math.max(0.5, depth * 0.05); // stagger each path in paint order so coplanar faces never z-fight (blink)
    data.paths.forEach((p, i) => {
      const style = (p.userData && p.userData.style) || {};
      const hasFill = style.fill === undefined || style.fill !== 'none';
      const hasStroke = typeof style.stroke === 'string' && style.stroke !== 'none' && style.stroke !== '';
      const zPos = i * zStep;
      // --- filled shapes (with holes preserved via toShapes) ---
      if (hasFill) {
        const col = resolveFill(THREE, style, p, svgText);
        const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.5, metalness: 0.16, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1 - i, polygonOffsetUnits: -1 - i });
        (p.toShapes(true) || []).forEach(sh => {
          const geo = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: true, bevelThickness: depth * 0.12, bevelSize: depth * 0.09, bevelSegments: 2, curveSegments: 14 });
          const mesh = new THREE.Mesh(geo, mat);
          mesh.position.z = zPos;
          grp.add(mesh);
        });
      }
      // --- stroke-only / stroked subpaths (monoline): build a solid bar per subpath ---
      if (hasStroke) {
        const col = (function () { try { return new THREE.Color(style.stroke); } catch (e) { return new THREE.Color('#6B4CA6'); } })();
        const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.5, metalness: 0.16, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1 - i, polygonOffsetUnits: -1 - i });
        const sStyle = THREE.SVGLoader.getStrokeStyle(
          parseFloat(style.strokeWidth) || 1,
          style.stroke,
          style.strokeLineJoin || 'round',
          style.strokeLineCap || 'round',
          parseFloat(style.strokeMiterLimit) || 4
        );
        (p.subPaths || []).forEach(sp => {
          const pts = sp.getPoints();
          if (!pts || pts.length < 2) return;
          const flat = THREE.SVGLoader.pointsToStroke(pts, sStyle, 12);
          if (!flat) return;
          const geo = thicken(THREE, flat, depth);
          const mesh = new THREE.Mesh(geo, mat);
          mesh.position.z = zPos;
          grp.add(mesh);
        });
      }
    });
    grp.scale.y = -1; // SVG y-down -> Three y-up
    const box = new THREE.Box3().setFromObject(grp);
    const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
    grp.position.sub(c);
    const pivot = new THREE.Group(); pivot.add(grp); scene.add(pivot);
    const R = Math.max(s.x, s.y) * 0.5 || 100;

    const cam = new THREE.PerspectiveCamera(32, 1, 1, R * 80);
    cam.position.set(0, R * 0.1, R * 5.7); cam.lookAt(0, 0, 0); // pull back so rotating marks never crop
    scene.add(new THREE.AmbientLight(0xffffff, 0.74));
    const k = new THREE.DirectionalLight(0xffffff, 0.95); k.position.set(-1, 1.35, 1.4); scene.add(k);
    const f = new THREE.DirectionalLight(0xcdb8ff, 0.35); f.position.set(1.2, 0.1, -0.9); scene.add(f);

    const ctr = new THREE.OrbitControls(cam, renderer.domElement);
    ctr.enableDamping = true; ctr.dampingFactor = 0.08; ctr.enablePan = false;
    ctr.minDistance = R * 2.4; ctr.maxDistance = R * 9;
    ctr.autoRotate = true; ctr.autoRotateSpeed = 2.4;

    function rs() { const w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h) return; renderer.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); }
    function loop() { requestAnimationFrame(loop); if (canvas.dataset.paused === '1') return; rs(); ctr.update(); renderer.render(scene, cam); }
    loop();
    if ('IntersectionObserver' in g) new IntersectionObserver(es => es.forEach(e => { canvas.dataset.paused = e.isIntersecting ? '0' : '1'; }), { rootMargin: '120px' }).observe(canvas);
  }
  g.LogoExtrude = { init };
})(window);
