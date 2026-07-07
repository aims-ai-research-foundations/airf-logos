/* Turn a flat logo SVG into an auto-spinning, orbit-able extruded 3D object. */
(function (g) {
  function vbSize(svg) {
    const m = svg.match(/viewBox="([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)"/);
    return m ? { w: +m[3], h: +m[4] } : { w: 200, h: 200 };
  }
  function init(canvas, svgText) {
    const THREE = g.THREE;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(g.devicePixelRatio || 1, 2));
    const scene = new THREE.Scene();
    const vb = vbSize(svgText);
    const depth = Math.max(6, 0.11 * Math.min(vb.w, vb.h));
    const data = new THREE.SVGLoader().parse(svgText);
    const grp = new THREE.Group();
    data.paths.forEach(p => {
      const col = p.color ? p.color : new THREE.Color('#6B4CA6');
      const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.5, metalness: 0.16, side: THREE.DoubleSide });
      (p.toShapes(true) || []).forEach(sh => {
        const geo = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: true, bevelThickness: depth * 0.12, bevelSize: depth * 0.09, bevelSegments: 2, curveSegments: 14 });
        grp.add(new THREE.Mesh(geo, mat));
      });
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
