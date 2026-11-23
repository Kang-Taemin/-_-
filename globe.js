"use strict";

const longitudeCount = 360;
const latitudeCount = 181;
const earthRadiusMetres = 6371000;
const elevationExaggeration = 60;
const heightScale = elevationExaggeration / earthRadiusMetres;
const degreesToRadians = Math.PI / 180;
const normalMapWidth = longitudeCount + 1;

function readElevations(csv) {
    const rows = csv.trim().split(/\r?\n/);
    if (rows.shift().split(",").map(field => field.trim()).join(",") !== "lat,lon,elevation_m") {
        throw new Error("CSV 헤더에 lat, lon, elevation_m 열이 필요합니다.");
    }

    const elevations = new Float64Array(latitudeCount * longitudeCount).fill(NaN);
    for (const row of rows) {
        const fields = row.split(",").map(field => field.trim());
        const [latitude, longitude, elevation] = fields.map(Number);
        if (fields.length !== 3 || fields.includes("") ||
            !Number.isInteger(latitude) || Math.abs(latitude) > 90 ||
            !Number.isInteger(longitude) || Math.abs(longitude) > 180 ||
            !Number.isFinite(elevation)) {
            throw new Error("CSV에 잘못된 위도, 경도 또는 고도가 있습니다.");
        }
        // +180° and -180° are the same meridian. Use the -180° samples.
        if (longitude !== 180) {
            const index = (90 - latitude) * longitudeCount + longitude + 180;
            elevations[index] = elevation;
        }
    }
    if (elevations.some(Number.isNaN)) {
        throw new Error("CSV에 누락된 1° 격자점이 있습니다.");
    }
    return elevations;
}

function poleElevation(elevations, row) {
    const start = row * longitudeCount;
    return elevations.subarray(start, start + longitudeCount)
        .reduce((sum, elevation) => sum + elevation, 0) / longitudeCount;
}

function buildNormalMap(elevations) {
    const pixels = new Uint8Array(normalMapWidth * latitudeCount * 4);
    const lastRow = latitudeCount - 1;
    const northPole = poleElevation(elevations, 0);
    const southPole = poleElevation(elevations, lastRow);

    function writeNormal(offset, east, north) {
        const length = Math.hypot(east, north, 1);
        pixels[offset] = Math.round(128 + 127 * east / length);
        pixels[offset + 1] = Math.round(128 + 127 * north / length);
        pixels[offset + 2] = Math.round(128 + 127 / length);
        pixels[offset + 3] = 255;
    }

    for (let row = 0; row <= lastRow; row++) {
        // Texture v increases northward, opposite the CSV row order.
        const start = (lastRow - row) * normalMapWidth * 4;
        const cosLatitude = Math.cos((90 - row) * degreesToRadians);
        for (let column = 0; column < longitudeCount; column++) {
            const offset = start + column * 4;
            if (row === 0 || row === lastRow) {
                writeNormal(offset, 0, 0);
                continue;
            }
            const left = (column + longitudeCount - 1) % longitudeCount;
            const right = (column + 1) % longitudeCount;
            const eastRise = elevations[row * longitudeCount + right] - elevations[row * longitudeCount + left];
            const above = row === 1 ? northPole : elevations[(row - 1) * longitudeCount + column];
            const below = row === lastRow - 1 ? southPole : elevations[(row + 1) * longitudeCount + column];
            const radius = 1 + elevations[row * longitudeCount + column] * heightScale;
            const step = 2 * degreesToRadians * radius;
            writeNormal(offset, -eastRise * heightScale / (step * cosLatitude),
                (below - above) * heightScale / step);
        }
        // Duplicate the antimeridian texel for both ends of the UV range.
        pixels.copyWithin(start + longitudeCount * 4, start, start + 4);
    }
    return pixels;
}

function triangle(a, b, c, mesh, offset) {
    const { vertices, vertexIds, normalSums, texCoords } = mesh;
    const start = offset;
    const corners = [a, b, c];
    for (const [x, y, z, elevation, id, u, v] of corners) {
        const radius = 1 + elevation * heightScale;
        const index = offset / 4;
        vertexIds[index] = id;
        texCoords[2 * index] = u;
        texCoords[2 * index + 1] = v;
        vertices[offset++] = x * radius;
        vertices[offset++] = y * radius;
        vertices[offset++] = z * radius;
        vertices[offset++] = elevation;
    }

    const ab = [
        vertices[start + 4] - vertices[start],
        vertices[start + 5] - vertices[start + 1],
        vertices[start + 6] - vertices[start + 2]
    ];
    const ac = [
        vertices[start + 8] - vertices[start],
        vertices[start + 9] - vertices[start + 1],
        vertices[start + 10] - vertices[start + 2]
    ];
    // The cross product weights each face by its area before smoothing.
    const [nx, ny, nz] = cross(ab, ac);
    for (const corner of corners) {
        const normalOffset = corner[4] * 3;
        normalSums[normalOffset] += nx;
        normalSums[normalOffset + 1] += ny;
        normalSums[normalOffset + 2] += nz;
    }
    return offset;
}

function expandVertexNormals(normalSums, vertexIds) {
    for (let i = 0; i < normalSums.length; i += 3) {
        const length = Math.hypot(normalSums[i], normalSums[i + 1], normalSums[i + 2]);
        normalSums[i] /= length;
        normalSums[i + 1] /= length;
        normalSums[i + 2] /= length;
    }

    const normals = new Float32Array(vertexIds.length * 3);
    for (let i = 0; i < vertexIds.length; i++) {
        const source = vertexIds[i] * 3;
        const target = i * 3;
        normals[target] = normalSums[source];
        normals[target + 1] = normalSums[source + 1];
        normals[target + 2] = normalSums[source + 2];
    }
    return normals;
}

function buildGlobe(elevations) {
    const rings = [];
    for (let row = 1; row < latitudeCount - 1; row++) {
        const latitude = (90 - row) * degreesToRadians;
        const cosLatitude = Math.cos(latitude);
        const sinLatitude = Math.sin(latitude);
        const ring = [];
        const v = 1 - row / (latitudeCount - 1);
        for (let column = 0; column < longitudeCount; column++) {
            const longitude = (column - 180) * degreesToRadians;
            ring.push([
                cosLatitude * Math.cos(longitude),
                sinLatitude,
                -cosLatitude * Math.sin(longitude),
                elevations[row * longitudeCount + column],
                (row - 1) * longitudeCount + column,
                column / longitudeCount,
                v
            ]);
        }
        const seam = ring[0].slice();
        seam[5] = 1;
        ring.push(seam);
        rings.push(ring);
    }

    // All longitude samples meet at a single vertex at each pole.
    const northId = rings.length * longitudeCount;
    const southId = northId + 1;
    const north = [0, 1, 0, poleElevation(elevations, 0), northId, 0, 1];
    const south = [0, -1, 0, poleElevation(elevations, latitudeCount - 1), southId, 0, 0];

    const vertexCount = 2 * rings.length * longitudeCount * 3;
    const mesh = {
        vertices: new Float32Array(vertexCount * 4),
        texCoords: new Float32Array(vertexCount * 2),
        vertexIds: new Uint32Array(vertexCount),
        normalSums: new Float64Array((southId + 1) * 3)
    };
    const firstRing = rings[0];
    const lastRing = rings[rings.length - 1];
    let offset = 0;
    for (let column = 0; column < longitudeCount; column++) {
        const next = column + 1;
        north[5] = south[5] = (column + 0.5) / longitudeCount;
        offset = triangle(north, firstRing[column], firstRing[next], mesh, offset);
        for (let row = 0; row < rings.length - 1; row++) {
            const upper = rings[row];
            const lower = rings[row + 1];
            offset = triangle(upper[column], lower[column], lower[next], mesh, offset);
            offset = triangle(upper[column], lower[next], upper[next], mesh, offset);
        }
        offset = triangle(lastRing[column], south, lastRing[next], mesh, offset);
    }
    return {
        vertices: mesh.vertices,
        texCoords: mesh.texCoords,
        normals: expandVertexNormals(mesh.normalSums, mesh.vertexIds)
    };
}

const canvas = document.getElementById("gl-canvas");
const csvInput = document.getElementById("elevation-csv");
const statusMessage = document.getElementById("status");
const gl = WebGLUtils.setupWebGL(canvas);

if (gl) {
    const program = initShaders(gl, "vertex-shader", "fragment-shader");
    if (program !== -1) {
        initGlobe(program);
    } else {
        statusMessage.textContent = "지구본 셰이더를 초기화할 수 없습니다.";
    }
} else {
    statusMessage.textContent = "이 브라우저에서 WebGL을 사용할 수 없습니다.";
}

function initGlobe(program) {
    gl.useProgram(program);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.035, 0.055, 0.08, 1);
    gl.enable(gl.DEPTH_TEST);

    const vertexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    const position = gl.getAttribLocation(program, "position");
    const elevation = gl.getAttribLocation(program, "elevation");
    const modelViewLocation = gl.getUniformLocation(program, "modelView");
    const projectionLocation = gl.getUniformLocation(program, "projection");
    const viewLocation = gl.getUniformLocation(program, "view");
    const lightDirLocation = gl.getUniformLocation(program, "uLightDir");
    const useBumpLocation = gl.getUniformLocation(program, "uUseBump");
    gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 16, 0);
    gl.vertexAttribPointer(elevation, 1, gl.FLOAT, false, 16, 12);
    gl.enableVertexAttribArray(position);
    gl.enableVertexAttribArray(elevation);

    const normalBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
    const vNormal = gl.getAttribLocation(program, "vNormal");
    gl.vertexAttribPointer(vNormal, 3, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(vNormal);

    const texCoordBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
    const vTexCoord = gl.getAttribLocation(program, "vTexCoord");
    gl.vertexAttribPointer(vTexCoord, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(vTexCoord);

    const normalTexture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, normalTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(gl.getUniformLocation(program, "uNormalMap"), 0);
    gl.uniform2f(gl.getUniformLocation(program, "uNormalMapSize"), normalMapWidth, latitudeCount);

    const spinControls = document.getElementById("spin-controls");
    const spinToggle = document.getElementById("spin-toggle");
    const spinSpeedInput = document.getElementById("spin-speed");
    const spinSpeedValue = document.getElementById("spin-speed-value");
    const sunAngleInput = document.getElementById("sun-angle");
    const sunAngleValue = document.getElementById("sun-angle-value");
    const radiusInput = document.getElementById("camera-radius");
    const radiusValue = document.getElementById("camera-radius-value");
    const terrainMode = document.getElementById("terrain-mode");
    const comparisonLabels = document.getElementById("comparison-labels");
    const axialTilt = rotateZ(23.5);
    const minRadius = Number(radiusInput.min);
    const maxRadius = Number(radiusInput.max);

    let vertexCount = 0;
    let radius = radiusInput.valueAsNumber;
    let longitude = 125 * degreesToRadians;
    let latitude = 30 * degreesToRadians;
    let pointerId = null;
    let pointerX;
    let pointerY;
    let spinAngle = 0;
    let spinSpeed = Number(spinSpeedInput.value);
    let isSpinning = true;
    let framePending = false;
    let lastFrameTime = null;
    let csvLoadId = 0;

    function drawTerrain(useBump, x, width) {
        gl.viewport(x, 0, width, canvas.height);
        gl.uniform1i(useBumpLocation, useBump ? 1 : 0);
        gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
    }

    function draw() {
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        if (vertexCount === 0) return;
        const eye = vec3(radius * Math.cos(latitude) * Math.cos(longitude),
            radius * Math.sin(latitude), -radius * Math.cos(latitude) * Math.sin(longitude));
        const viewMatrix = lookAt(eye, vec3(0, 0, 0), vec3(0, 1, 0));
        const modelMatrix = mult(axialTilt, rotateY(spinAngle));
        const modelViewMatrix = mult(viewMatrix, modelMatrix);
        gl.uniformMatrix4fv(viewLocation, false, flatten(viewMatrix));
        gl.uniformMatrix4fv(modelViewLocation, false, flatten(modelViewMatrix));
        const mode = terrainMode.value;
        const compare = mode === "compare";
        const viewportWidth = compare ? canvas.width / 2 : canvas.width;
        drawTerrain(mode === "bump", 0, viewportWidth);
        if (compare) drawTerrain(true, viewportWidth, viewportWidth);
    }

    function updateComparisonLayout() {
        const compare = terrainMode.value === "compare";
        const columns = compare ? 2 : 1;
        const width = canvas.height * columns;
        if (canvas.width !== width) canvas.width = width;
        canvas.classList.toggle("comparison", compare);
        comparisonLabels.hidden = !compare;
        const aspect = canvas.width / columns / canvas.height;
        gl.uniformMatrix4fv(projectionLocation, false, flatten(perspective(45, aspect, 0.1, 20)));
    }

    function updateRadius(distance) {
        radius = Math.max(minRadius, Math.min(maxRadius, distance));
        radiusInput.value = String(radius);
        radiusValue.value = radius.toFixed(2);
        requestFrame();
    }

    function updateSunDirection() {
        const degrees = Number(sunAngleInput.value);
        const azimuth = degrees * degreesToRadians;
        gl.uniform3f(lightDirLocation, Math.cos(azimuth), 0, -Math.sin(azimuth));
        sunAngleValue.value = String(degrees);
    }

    function requestFrame() {
        if (framePending) return;
        framePending = true;
        window.requestAnimFrame(renderFrame);
    }

    function renderFrame(timestamp = performance.now()) {
        framePending = false;
        if (isSpinning) {
            if (lastFrameTime !== null) {
                const elapsedSeconds = (timestamp - lastFrameTime) / 1000;
                spinAngle = (spinAngle + spinSpeed * elapsedSeconds) % 360;
            }
            lastFrameTime = timestamp;
        }
        draw();
        if (isSpinning) requestFrame();
    }

    spinToggle.addEventListener("click", () => {
        isSpinning = !isSpinning;
        lastFrameTime = null;
        spinToggle.textContent = isSpinning ? "일시정지" : "재생";
        if (isSpinning) requestFrame();
    });

    spinSpeedInput.addEventListener("input", () => {
        spinSpeed = Number(spinSpeedInput.value);
        spinSpeedValue.value = String(spinSpeed);
    });

    sunAngleInput.addEventListener("input", () => {
        updateSunDirection();
        requestFrame();
    });

    terrainMode.addEventListener("change", () => {
        updateComparisonLayout();
        requestFrame();
    });

    radiusInput.addEventListener("input", () => {
        updateRadius(radiusInput.valueAsNumber);
    });

    document.addEventListener("visibilitychange", () => { lastFrameTime = null; });

    async function loadCsv(file) {
        const loadId = ++csvLoadId;
        statusMessage.textContent = file ? "CSV를 읽는 중…" : "기본 고도 CSV를 불러오는 중…";
        try {
            let csv;
            if (file) {
                csv = await file.text();
            } else {
                const response = await fetch("ETOPO_2022_ice_surface_1deg.csv");
                if (!response.ok) throw new Error("기본 CSV 응답 오류: " + response.status);
                csv = await response.text();
            }
            if (loadId !== csvLoadId) return;
            const elevations = readElevations(csv);
            const { vertices, normals, texCoords } = buildGlobe(elevations);
            const normalMap = buildNormalMap(elevations);
            gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
            gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, normals, gl.STATIC_DRAW);
            gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.STATIC_DRAW);
            gl.bindTexture(gl.TEXTURE_2D, normalTexture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, normalMapWidth, latitudeCount, 0,
                gl.RGBA, gl.UNSIGNED_BYTE, normalMap);
            vertexCount = vertices.length / 4;
            spinControls.disabled = false;
            requestFrame();
            statusMessage.textContent = "드래그로 시점을 바꾸고 휠로 확대·축소할 수 있습니다.";
        } catch (error) {
            if (loadId !== csvLoadId) return;
            statusMessage.textContent = file ? error.message :
                "기본 CSV를 자동으로 불러오지 못했습니다. ETOPO 1° CSV 파일을 선택하세요.";
        }
    }

    csvInput.addEventListener("change", () => {
        const file = csvInput.files[0];
        if (file) void loadCsv(file);
    });

    canvas.addEventListener("pointerdown", event => {
        if (event.button !== 0 || vertexCount === 0) return;
        pointerId = event.pointerId;
        pointerX = event.clientX;
        pointerY = event.clientY;
        canvas.setPointerCapture(pointerId);
    });
    canvas.addEventListener("pointermove", event => {
        if (event.pointerId !== pointerId) return;
        longitude -= (event.clientX - pointerX) * 0.01;
        latitude = Math.max(-1.55, Math.min(1.55, latitude + (event.clientY - pointerY) * 0.01));
        pointerX = event.clientX;
        pointerY = event.clientY;
        requestFrame();
    });
    canvas.addEventListener("lostpointercapture", () => { pointerId = null; });
    canvas.addEventListener("wheel", event => {
        if (vertexCount === 0 || event.ctrlKey) return;
        const deltaMode = event.deltaMode;
        let delta = event.deltaY;
        if (delta === 0) return;
        event.preventDefault();
        if (deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16;
        if (deltaMode === WheelEvent.DOM_DELTA_PAGE) delta *= canvas.clientHeight;
        updateRadius(radius * Math.exp(delta * 0.0015));
    }, { passive: false });
    updateComparisonLayout();
    updateSunDirection();
    radiusValue.value = radius.toFixed(2);
    csvInput.disabled = false;
    draw();
    void loadCsv();
}
