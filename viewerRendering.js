var canvas;
var gl;
var program;

// shader data locations
var modelViewMatrixLoc;
var projectionMatrixLoc;
var vertexObject;

// default splat instance count
var numInstances = 100;

// Camera control vars
var camX = 0.0;
var camY = 0.0;
var camZ = 2.0;
var flySpeed = 0.2;

// Model rotation vars
var dragging = false;
var prevMouseX = -1;
var prevMouseY = -1;
var modelRotationX = 0.0;
var modelRotationY = 0.0;
var modelRotationZ = 0.0;

// frame-buffer vars for frame relighting
var gBuffer;
var colorTexture;
var posTexture;
var depthBuffer;

// lighting variables
var lightingProgram;
var screenBackground;
var colorTexLoc;
var posTexLoc;

// Mesh vars
var meshToggle = false; // keeping track of whether mesh mode has been toggled
var meshVertexObj; // separate vertex object for rendering geometry
var meshICount; // index count
var meshIType; // index type
var meshProgram; // for separate lighting
var defaultMeshTex; // mesh texture
var glbTexture = null; // texture pulled from glb object
var glassToggle = false;

// Skybox vars
var sbCubeMap;
var sbObject;
var sbPoints = [];
var sbVertices = [ // 3D box around camera
    vec4( -0.5, -0.5,  0.5, 1.0 ), // Top back left
    vec4( -0.5,  0.5,  0.5, 1.0 ), // Top front left
    vec4( 0.5,  0.5,  0.5, 1.0 ),  // Top front right
    vec4( 0.5, -0.5,  0.5, 1.0 ), // Top back right
    vec4( -0.5, -0.5, -0.5, 1.0 ), // Bottom back left
    vec4( -0.5,  0.5, -0.5, 1.0 ), // Bottom front left
    vec4( 0.5,  0.5, -0.5, 1.0 ),  // Bottom front right
    vec4( 0.5, -0.5, -0.5, 1.0 ) // Bottom back right
];

// Mesh lighting vars
var lightPosition = vec4(0.2, 4.0, 1.0, 1.0 );
var lightAmbient = vec4(0.2, 0.2, 0.2, 1.0 );
var lightDiffuse = vec4( 1.0, 1.0, 1.0, 1.0 );
var lightSpecular = vec4( 1.0, 1.0, 1.0, 1.0 );

var materialAmbient = vec4( 1.0, 0.0, 1.0, 1.0 );
var materialDiffuse = vec4( 1.0, 1.0, 0.0, 1.0 );
var materialSpecular = vec4( 1.0, 1.0, 1.0, 1.0 );
var materialShininess = 20.0;

// Spotlight vars
var spotDirection = vec3(0.0, 0.0, -1.0);
var spotCutoff = Math.cos(2.0 * Math.PI / 180.0); // finding once here to pass down
var spotDropoff = 20.0
var floorObject;


/**
 * This asynchronous function parses the data from a .glb file using the loaders.gl library. The details of the
 * glb file are returned in an object of parameters.
 *
 * The loaders.gl library was chosen here for simplicity of setup and the fact that it will
 * not do the heavy lifting of rendering lighting, shadows, and more-- as opposed to other libraries
 * which are much heavier and do more than needed.
 *
 * @param url The path for the .glb model file to be parsed.
 * @returns {Promise<{positions, normals: (*|null), uvs: (*|null), indices, indexType: (0x1405|0x1403), indexCount}>}
 *          A promised object containing the positions of the vertices, the normals and uv maps, the indices, their amount, and their type.
 */
async function loadGLB(url) {
    console.log("Getting GLB data with loaders.gl library.");

    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();

    // request loaders parse function
    const gltf = await loaders.parse(arrayBuffer, loaders.GLTFLoader);

    // get primitive object from mesh
    const primitive = gltf.meshes[0].primitives[0];

    let textureImage = null;
    if (gltf.images && gltf.images.length > 0) {
        textureImage = gltf.images[0].image;
        console.log("GLB has texture");
    }

    let indices = null;
    let indexType = null;
    let indexCount = 0;

    if (primitive.indices) {
        indices = primitive.indices.value;
        indexCount = indices.length;
        if (indices instanceof Uint32Array) indexType = gl.UNSIGNED_INT;
        else if (indices instanceof Uint16Array) indexType = gl.UNSIGNED_SHORT;
        else if (indices instanceof Uint8Array) indexType = gl.UNSIGNED_BYTE;
    }

    // need to manually calculate size of the color vectors (RGB is 3 and RGBA is 4)
    // for some reason it seems that the passed size is undefined, which is resulting in
    // the shading calculations crashing. We are assuming RGBA here
    let cSize = 4;


    console.log("GLB data successfully loaded.");

    return {
        positions: primitive.attributes.POSITION.value,
        normals: primitive.attributes.NORMAL ? primitive.attributes.NORMAL.value : null,
        uvs: primitive.attributes.TEXCOORD_0 ? primitive.attributes.TEXCOORD_0.value : null,
        colors: primitive.attributes.COLOR_0 ? primitive.attributes.COLOR_0.value : null,
        colorSize: cSize,
        indices: indices,
        indexType: indexType,
        indexCount: indexCount,
        image: textureImage
    };
}

/**
 * An asynchronous function for parsing the PLY model file, which reads the number of instances,
 * and returns the splat point and color data. This will generally NOT work on regular PLY models, only Gaussian Splat PLYs.
 *
 * This function was sourced through a combination of online searches for parsing Gaussian Splat model data. A library was not used to perform this import because it was
 * relatively simple to include here, and such libraries are unnecessarily heavy for this purpose alone.
 *
 * @param url The file path for the PLY model to be parsed.
 * @returns {Promise<{numInstances: number, positions: Float32Array, colors: Float32Array}|null>} An async promise of
 *          an object containing the number of splat instances, the positions of them, and the colors of them.
 */
async function parseSplatPLY(url){
    console.log("Fetching PLY data from: " + url);
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();

    // Read header to find vertex count & binary start
    const textDecoder = new TextDecoder();
    const header = textDecoder.decode(new Uint8Array(buffer, 0, 1024 * 10));

    const headerEnd = header.indexOf("end_header\n") + 11;
    const vertexCountMatch = header.match(/element vertex (\d+)/);

    if(!vertexCountMatch) {
        console.error("Could not find vertex count in header.");
        return null;
    }

    const vertexCount = parseInt(vertexCountMatch[1]);

    const props = header.slice(0, headerEnd).match(/property/g);
    const stride = props.length * 4;

    console.log("Successfully parsed header. Loading splats...");

    const dataView = new DataView(buffer, headerEnd);
    const positions = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 4);

    // converting spherical harmonics (used for Gaussian Splats) into RGB values
    const SH_C0 = 0.28209479177387814;

    for (let i = 0; i < vertexCount; i++){
        const byteOffset = i * stride;

        // get position
        // x, y, z are first 3 properties, byte 0, 4, 8
        positions[i*3 + 0] = dataView.getFloat32(byteOffset + 0, true);
        positions[i*3 + 1] = dataView.getFloat32(byteOffset + 4, true);
        positions[i*3 + 2] = dataView.getFloat32(byteOffset + 8, true);

        // get colors -- bytes 24, 28, 32
        let r = 0.5 + (SH_C0 * dataView.getFloat32(byteOffset + 24, true));
        let g = 0.5 + (SH_C0 * dataView.getFloat32(byteOffset + 28, true));
        let b = 0.5 + (SH_C0 * dataView.getFloat32(byteOffset + 32, true));

        // limit colors to 0.0 and 1.0
        colors[i*4 + 0] = Math.max(0, Math.min(1, r));
        colors[i*4 + 1] = Math.max(0, Math.min(1, g));
        colors[i*4 + 2] = Math.max(0, Math.min(1, b));
        colors[i*4 + 3] = 1.0;
    }

    console.log("Finished getting instance data.");
    return { numInstances: vertexCount, positions: positions, colors: colors };
}

/**
 * A helper function to push four points in an order that allows two triangles (making up
 * a square face) to be rendered later on.
 *
 * Each of the four vertex locations passed to this function will be called from an array of stored
 * vertices in order to pass the required points for two triangles to be rendered. The points are
 * pushed to another, separate array of points.
 *
 * @param a The first vertex location on the quad face.
 * @param b The second vertex location on the quad face.
 * @param c The third vertex location on the quad face.
 * @param d The fourth vertex location on the quad face.
 */
function quad(a, b, c, d){
    sbPoints.push(sbVertices[a]);
    sbPoints.push(sbVertices[b]);
    sbPoints.push(sbVertices[c]);
    sbPoints.push(sbVertices[a]);
    sbPoints.push(sbVertices[c]);
    sbPoints.push(sbVertices[d]);
}

/**
 * A helper function for creating a cube using the quad function to draw all
 * six faces.
 *
 * This function calls quad six times all with various combinations of vertex locations
 * to render a quad face for each different face of a cube. The locations given to quad are
 * representing the index of the vertices within another array.
 */
function cube(){
    quad(1, 0, 3, 2); // top face
    quad(2, 3, 7, 6); // right face
    quad(0, 4, 7, 3); // back face
    quad(5, 1, 2, 6); // front face
    quad(6, 7, 4, 5); // bottom face
    quad(5, 4, 0, 1); // left face
}

/**
 * A function for generating the geometry for the skybox.
 *
 * This function uses the cube function to generate a cube geometry for the skybox. This
 * shape is then pushed to a buffer to be rendered by the GPU.
 */
function makeSb(){
    cube(); // make vertices for skybox cube
    sbObject = gl.createVertexArray();
    gl.bindVertexArray(sbObject);

    var sbBuff = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, sbBuff);
    gl.bufferData(gl.ARRAY_BUFFER, flatten(sbPoints), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
}

/**
 * A function for generating a default texture of an object within the scene.
 *
 * The default texture generated by this function should be a 2x2 checkerboard, to be used when
 * an object is untextured or the default texture is willingly used.
 */
function defaultTex() {
    defaultMeshTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, defaultMeshTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // checkerboard as default
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 255, 255, 255, 0, 0, 255, 0, 0, 255, 255, 0, 255, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
}

/**
 * A helper function for binding the custom skybox texture to a cube map.
 * This custom skybox texture is used when texturing the skybox in the graphics shader.
 */
function sbConfig() {
    sbCubeMap = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, sbCubeMap);

    // smoothing
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // find custom images downloaded from https://freestylized.com/skybox/sky_46/ I found for cool skybox
    const sbFaces = [
        { target: gl.TEXTURE_CUBE_MAP_POSITIVE_X, url: 'px.png' },
        { target: gl.TEXTURE_CUBE_MAP_NEGATIVE_X, url: 'nx.png' },
        { target: gl.TEXTURE_CUBE_MAP_POSITIVE_Y, url: 'py.png' },
        { target: gl.TEXTURE_CUBE_MAP_NEGATIVE_Y, url: 'ny.png' },
        { target: gl.TEXTURE_CUBE_MAP_POSITIVE_Z, url: 'pz.png' },
        { target: gl.TEXTURE_CUBE_MAP_NEGATIVE_Z, url: 'nz.png' }
    ];

    // for each face bind the image as the texture on the cubeMap ( or a pixel before they load)
    sbFaces.forEach(face => {
        // making black pixel for side if image not loaded yet (without, webGL keeps crashing before image load)
        gl.texImage2D(face.target, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]))

        const image = new Image();
        image.src = face.url;
        image.onload = function () {
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_CUBE_MAP, sbCubeMap);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            gl.texImage2D(face.target, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        };
    });
}

function buildFloor() {
    floorObject = gl.createVertexArray();
    gl.bindVertexArray(floorObject);

    // floor is 10x10 plane
    var y = -1.0;
    var points = new Float32Array([
        -5.0, y, -5.0,
        -5.0, y,  5.0,
        5.0, y,  5.0,
        -5.0, y, -5.0,
        5.0, y,  5.0,
        5.0, y, -5.0
    ])
    // normals all face upward
    var normals = new Float32Array([
        0,1,0,
        0,1,0,
        0,1,0,
        0,1,0,
        0,1,0,
        0,1,0
    ])
    var uvs = new Float32Array([
        0,0,
        0,5,
        5,5,
        0,0,
        5,5,
        5,0
    ])
    var pointsBuff = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, pointsBuff);
    gl.bufferData(gl.ARRAY_BUFFER, points, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    var normalsBuff = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, normalsBuff);
    gl.bufferData(gl.ARRAY_BUFFER, normals, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);

    var uvsBuff = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, uvsBuff);
    gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);
}



/**
 * A helper function for pushing the data from the mesh file to data buffers for rendering.
 *
 * The data from the mesh is parsed somewhere else and passed to this function, which is then used to
 * push to the graphics buffer for rendering in the scene. A separate vertex object must be made here to separate
 * this data from the PLY splat geometry.
 *
 * @param meshData The data parsed from the mesh object file.
 */
function buildMeshObject(meshData){
    meshICount = meshData.indexCount;
    meshIType = meshData.indexType;
    meshVertexObj = gl.createVertexArray();
    gl.bindVertexArray(meshVertexObj);

    var meshBuff = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, meshBuff);
    gl.bufferData(gl.ARRAY_BUFFER, meshData.positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    var indexBuff = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuff);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, meshData.indices, gl.STATIC_DRAW);

    if(meshData.normals){ // make sure normals are not null, if so do same thing
        var normalsBuff = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, normalsBuff);
        gl.bufferData(gl.ARRAY_BUFFER, meshData.normals, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    }
    if(meshData.uvs) { // make sure the uvs are not null, bind again
        var uvsBuff = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, uvsBuff);
        gl.bufferData(gl.ARRAY_BUFFER, meshData.uvs, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(2, meshData.color, gl.FLOAT, false, 0, 0);
    }

    if(meshData.colors) { // bind colors
        var colorsBuff = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, colorsBuff);
        gl.bufferData(gl.ARRAY_BUFFER, meshData.colors, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(3); // layout position 3 in MESH vertex shader
        // tried with floats and it didn't work, meshes must be getting generated as byte, and need to be normalized for shading
        gl.vertexAttribPointer(3, meshData.colorSize, gl.UNSIGNED_BYTE, true, 0, 0);
    }

    if (meshData.image) { // bind image texture if it exists ( these glbs use vertex colors)
        glbTexture = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, glbTexture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, meshData.image);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }

    gl.bindVertexArray(null);
}

/**
 * A helper function for pushing the data from the splat file to data buffers for rendering.
 *
 * The data from the splat is parsed somewhere else and passed to this function, which is then used to
 * push to the graphics buffer for rendering in the scene. A separate vertex object must be made here to separate
 * this data from the glb mesh geometry.
 *
 * @param meshData The data parsed from the PLY object file.
 */
function buildSplatObject(splatData){
    vertexObject = gl.createVertexArray();
    gl.bindVertexArray(vertexObject);

    // square at origin
    const quadVerts = new Float32Array([
        -1.0, -1.0, // bottom left
        1.0, -1.0, // bottom right
        -1.0, 1.0, // top left
        1.0, 1.0, // top right
    ]);

    var quadBuf = gl.createBuffer(); // buffer for base
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // update the number of instances based on parse
    numInstances = splatData.numInstances;

    // instance positions, push them to buffer
    var posBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, splatData.positions, gl.STATIC_DRAW);
    const instancePosLoc = 1;
    gl.enableVertexAttribArray( instancePosLoc );
    gl.vertexAttribPointer(instancePosLoc, 3, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(instancePosLoc, 1);

    // instance colors, push them to buffer
    var colBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, colBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, splatData.colors, gl.STATIC_DRAW);
    const instanceColLoc = 2;
    gl.enableVertexAttribArray( instanceColLoc );
    gl.vertexAttribPointer(instanceColLoc, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(instanceColLoc, 1);

    gl.bindVertexArray(null);
}

window.onload = async function init() {

    canvas = document.getElementById( "gl-canvas" );

    // Need WebGl 2.0 for rendering splats
    gl = canvas.getContext("webgl2");
    if ( !gl ) {
        alert( "WebGL 2.0 isn't available" );
        return;
    }

    gl.getExtension("EXT_color_buffer_float");

    // make viewport, background, and program
    gl.viewport( 0, 0, canvas.width, canvas.height );
    gl.clearColor( 1.0, 1.0, 1.0, 1.0 );
    gl.enable(gl.DEPTH_TEST);
    program = initShaders(gl, "vertex-shader", "fragment-shader");
    lightingProgram = initShaders(gl, "relighting-vertex-shader", "relighting-fragment-shader");
    meshProgram = initShaders(gl, "mesh-vertex-shader", "mesh-fragment-shader");
    gl.useProgram(program);

    // load data from PLY file and GLB file
    const splatData = await parseSplatPLY("sonic/model.ply");
    const meshData = await loadGLB("sonic/model.glb");

    if (!splatData) {
        alert("Failed to load PLY file.");
        return;
    } else if (!meshData) {
        alert("Failed to load GLB file.");
    }

    // push the data from each file to their respective data buffers
    buildSplatObject(splatData);
    buildMeshObject(meshData);


    // Event listeners for user key interactions
    window.addEventListener("keydown", function(event) {
        switch(event.key){
            case "w": case "W":
                camZ -= flySpeed;
                break;
            case "s": case "S":
                camZ += flySpeed;
                break;
            case "a" : case "A":
                camX -= flySpeed;
                break;
            case "d" : case "D":
                camX += flySpeed;
                break;
            case "q" : case "Q":
                camY -= flySpeed;
                break;
            case "e" : case "E":
                camY += flySpeed;
                break;
            case "g": case "G":
                glassToggle = !glassToggle;
                break;
        }
    })

    // Event listeners for user mouse interactions
    canvas.addEventListener("mousedown", function(e){
        dragging = true;
        prevMouseX = e.clientX;
        prevMouseY = e.clientY;
    })

    canvas.addEventListener("mouseup", function(e){
        dragging = false;
    })

    // if mouse leaves canvas make it stop rotating
    canvas.addEventListener("mouseleave", function(e){
        dragging = false;
    })

    canvas.addEventListener("mousemove", function(e){
        if (dragging){
            var dX = e.clientX - prevMouseX; // find difference in mouse positions
            var dY = e.clientY - prevMouseY;

            // if shift key is pressed we can change direction of rotation
            if(e.shiftKey){
                modelRotationZ += dX * 0.5; // speed of rotation
            } else {
                modelRotationY += dX * 0.5;
                modelRotationX += dY * 0.5;
            }

            prevMouseX = e.clientX; // record this as preview location
            prevMouseY = e.clientY;
        }
    })

    document.getElementById("viewToggleBtn").addEventListener("click", function(e){
        meshToggle = !meshToggle;
    })

    setupFramebuffer(); // pass 1
    setupRelightingProgram(); // pass 2
    colorTexLoc = gl.getUniformLocation(lightingProgram, "uColorTex");
    posTexLoc = gl.getUniformLocation(lightingProgram, "uPosTex");

    makeSb(); // build the skybox object
    buildFloor(); // build the floor geometry
    defaultTex(); // bind a default texture
    sbConfig(); // bind the images for the skybox

    gl.useProgram(meshProgram); // connect textures to mesh program

    // mesh lighting setup
    gl.uniform4fv(gl.getUniformLocation(meshProgram, "lightDiffuse"), flatten(lightDiffuse));
    gl.uniform4fv(gl.getUniformLocation(meshProgram, "materialDiffuse"), flatten(materialDiffuse));
    gl.uniform4fv(gl.getUniformLocation(meshProgram, "lightSpecular"), flatten(lightSpecular));
    gl.uniform4fv(gl.getUniformLocation(meshProgram, "materialSpecular"), flatten(materialSpecular));
    gl.uniform4fv(gl.getUniformLocation(meshProgram, "lightAmbient"), flatten(lightAmbient));
    gl.uniform4fv(gl.getUniformLocation(meshProgram, "materialAmbient"), flatten(materialAmbient));
    gl.uniform4fv(gl.getUniformLocation(meshProgram, "lightPosition"), flatten(lightPosition));
    gl.uniform1f(gl.getUniformLocation(meshProgram, "shininess"), materialShininess);
    gl.uniform3fv(gl.getUniformLocation(meshProgram, "spotDirection"), flatten(spotDirection));
    gl.uniform1f(gl.getUniformLocation(meshProgram, "cutoff"), spotCutoff);
    gl.uniform1f(gl.getUniformLocation(meshProgram, "dropoff"), spotDropoff);

    gl.uniform1i(gl.getUniformLocation(meshProgram, "tex1"), 0);
    gl.uniform1i(gl.getUniformLocation(meshProgram, "texMap"), 1);

    render();
}

function setupFramebuffer(){
    // need to make a frame buffer of textures according to Andrew Chan Gaussian Splat re-lighting technique paper
    // this will essentially make a frame off-screen to then compute lighting on
    // this is similar to how video game graphics engines work it seems
    gBuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, gBuffer);

    // need to store splat colors to a texture with RGB
    colorTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, colorTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, canvas.width, canvas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colorTexture, 0);

    // need to store positions to a texture within frame
    posTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, posTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, canvas.width, canvas.height, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, posTexture, 0);

    // need to store depth for depth-testing on model
    depthBuffer = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depthBuffer);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, canvas.width, canvas.height);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthBuffer);

    // we need to render pos and color at the same time
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

    // check if frame was correctly drawn
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        console.error("Frame build failed")
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null); // return to screen rendering
}

function setupRelightingProgram(){
    // make background quad for second pass of frame for lighting
    screenBackground = gl.createVertexArray();
    gl.bindVertexArray(screenBackground);
    var backgroundBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, backgroundBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1.0, -1.0, 1.0, -1.0, -1.0, 1.0, 1.0, 1.0
    ]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray( 0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
}


function render() {
    // position camera and perspective according to user
    // both the objects (mesh and splat) need to maintain the same orientation, so
    // the math for orientation stays outside toggle check
    var eye = vec3(camX, camY, camZ);
    var at = vec3(camX, camY, 0.0); // must always look forward
    var up = vec3(0.0, 1.0, 0.0);
    var cameraMatrix = lookAt(eye, at, up);
    var modelMatrix = mat4();

    // allow rotation of splat model from the mouse movement, see event listeners
    modelMatrix = mult(modelMatrix, rotateX(modelRotationX));
    modelMatrix = mult(modelMatrix, rotateY(modelRotationY));
    modelMatrix = mult(modelMatrix, rotateZ(modelRotationZ));

    var fovy = 45.0;
    var aspect = canvas.width / canvas.height;
    var near = 0.1;
    var far = 100.0;
    var projectionMatrix = perspective(fovy, aspect, near, far);

    // check toggle for mesh or splat object
    if (meshToggle){
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.clearColor(0.0, 0.0, 0.0, 0.0); // background stays same color between toggles for continuity
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        gl.useProgram(meshProgram); // enable mesh shaders
        var normalMV = mult(cameraMatrix, modelMatrix);

        // push matrices for projection
        projectionMatrixLoc = gl.getUniformLocation(meshProgram, "projectionMatrix");
        gl.uniformMatrix4fv(projectionMatrixLoc, false, flatten(projectionMatrix));

        // skybox rendering
        gl.uniform1i(gl.getUniformLocation(meshProgram, "isSkybox"), 1); // tell shader that skybox is enabled
        gl.uniform1i(gl.getUniformLocation(meshProgram, "isShadow"), 0); // is not shadow or glass
        gl.uniform1i(gl.getUniformLocation(meshProgram, "isGlass"), 0);

        // bind texture for skybox
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_CUBE_MAP, sbCubeMap);

        var skyboxMatrix = scalem(50.0, 50.0, 50.0); // scale around scene
        gl.uniformMatrix4fv(gl.getUniformLocation(meshProgram, "modelMatrix"), false, flatten(skyboxMatrix));
        modelViewMatrixLoc = gl.getUniformLocation(meshProgram, "modelViewMatrix");
        gl.uniformMatrix4fv(modelViewMatrixLoc, false, flatten(cameraMatrix));

        gl.bindVertexArray(sbObject);
        gl.disable(gl.DEPTH_TEST); // keeps skybox behind everything, makes it as if everything is in front
        gl.drawArrays(gl.TRIANGLES, 0, 36);
        gl.enable(gl.DEPTH_TEST);

        // floor + default texture
        gl.uniform1i(gl.getUniformLocation(meshProgram, "isSkybox"), 0);
        gl.uniformMatrix4fv(modelViewMatrixLoc, false, flatten(cameraMatrix));
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, defaultMeshTex);
        gl.bindVertexArray(floorObject);
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        // shadows
        gl.uniform1i(gl.getUniformLocation(meshProgram, "isShadow"), 1); // tell shader this is shadow
        var shadowProj = mat4();
        shadowProj[3][3] = 0.0;
        shadowProj[3][1] = -1.0 / (lightPosition[1] - (-0.99));
        var firstTrans = translate(lightPosition[0], lightPosition[1], lightPosition[2]);
        var secondTrans = translate(lightPosition[0], -lightPosition[1], -lightPosition[2]);
        var flattenMatrix = mult(firstTrans, mult(shadowProj, secondTrans));
        var shadowMV = mult(cameraMatrix, mult(flattenMatrix, modelMatrix));
        gl.uniformMatrix4fv(modelViewMatrixLoc, false, flatten(shadowMV));

        gl.enable(gl.BLEND); // allows for the shadow to not just be total black
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        // to draw shadow, we just take mesh and draw it flat
        if (meshICount > 0) {
            gl.bindVertexArray(meshVertexObj);
            gl.drawElements(gl.TRIANGLES, meshICount, meshIType, 0);
        }
        gl.disable(gl.BLEND);


        // actual mesh rendering
        gl.uniformMatrix4fv(modelViewMatrixLoc, false, flatten(normalMV));
        gl.uniform1i(gl.getUniformLocation(meshProgram, "isSkybox"), 0); // tell shader this is no longer skybox
        gl.uniform1i(gl.getUniformLocation(meshProgram, "glassEnabled"), glassToggle ? 1 : 0); // indicate glass on or off
        gl.uniform1i(gl.getUniformLocation(meshProgram, "isShadow"), 0);

        gl.activeTexture(gl.TEXTURE0); // activate mesh texture if there is one
        if (glbTexture) { // if texture is from glb, use it, if not use default texture
            gl.bindTexture(gl.TEXTURE_2D, glbTexture);
        } else {
            gl.bindTexture(gl.TEXTURE_2D, defaultMeshTex);
        }

        // draw mesh objects
        if (meshICount > 0){
            gl.bindVertexArray(meshVertexObj);
            gl.drawElements(gl.TRIANGLES, meshICount, meshIType, 0);
        }

    } else {
        // following Andrew Chan's two-pass rendering
        // Pass 1 - render to frame buffer
        gl.bindFramebuffer(gl.FRAMEBUFFER, gBuffer); // take hold of frame buffer
        gl.clearColor(0.0, 0.0, 0.0, 0.0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        gl.useProgram(program);

        // view of splat on import is of the top, so rotating 90 degrees first will put it correctly
        // in view on import
        var modelViewMatrix = mult(cameraMatrix, modelMatrix);
        modelViewMatrix = mult(modelViewMatrix, rotateX(-90));

        // push matrices for camera and projection
        modelViewMatrixLoc = gl.getUniformLocation(program, "modelViewMatrix");
        projectionMatrixLoc = gl.getUniformLocation(program, "projectionMatrix");
        gl.uniformMatrix4fv(modelViewMatrixLoc, false, flatten(modelViewMatrix));
        gl.uniformMatrix4fv(projectionMatrixLoc, false, flatten(projectionMatrix));

        // draw shapes
        gl.bindVertexArray(vertexObject);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, numInstances);

        // Pass 2 - render frame to screen & apply re-lighting
        gl.bindFramebuffer(gl.FRAMEBUFFER, null); // go back to screen buffer

        // need to clear canvas again
        gl.clearColor(0.0, 0.0, 0.0, 0.0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        // enable lighting shaders
        gl.useProgram(lightingProgram);

        // use position and color textures from first pass
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, colorTexture);
        gl.uniform1i(colorTexLoc, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, posTexture);
        gl.uniform1i(posTexLoc, 1);

        // draw the screen background
        gl.bindVertexArray(screenBackground);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // request next frame
    requestAnimationFrame(render);
}
