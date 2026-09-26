var gl;
var points = [];

var numTimesToSubdivide = 0;

var bufferId;

var colorLoc;

// 네 정점 좌표
var vertices = [
    vec2(-0.5, -0.5),   // a : 왼쪽 아래
    vec2(-0.5,  0.5),   // b : 왼쪽 위
    vec2( 0.5,  0.5),   // c : 오른쪽 위
    vec2( 0.5, -0.5)    // d : 오른쪽 아래
];


window.onload = function init()
{
    var canvas = document.getElementById("gl-canvas");

    gl = WebGLUtils.setupWebGL(canvas);

    if (!gl) {
        alert("WebGL isn't available");
    }


    // WebGL 설정
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.0, 0.0, 0.0, 1.0);


    // 셰이더 초기화
    var program =
        initShaders(gl, "vertex-shader", "fragment-shader");

    gl.useProgram(program);

    // 색상 uniform 변수 위치 가져오기
    colorLoc = gl.getUniformLocation(program, "uColor");
    // 초기 색상: 빨강
    gl.uniform4f(colorLoc, 1.0, 0.0, 0.0, 1.0);

    // GPU 버퍼 생성
    bufferId = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bufferId);


    // 버퍼 -> vPosition 연결
    var vPosition =
        gl.getAttribLocation(program, "vPosition");

    gl.vertexAttribPointer(
        vPosition,
        2,
        gl.FLOAT,
        false,
        0,
        0
    );

    gl.enableVertexAttribArray(vPosition);


    // 슬라이더
    document.getElementById("slider").onchange =
        function(event)
        {
            numTimesToSubdivide =
                parseInt(event.target.value);

            render();
        };


    render();

    // 색상 선택기
    document.getElementById("colorPicker").oninput =
    function(event)
    {
        var color = event.target.value;

        var r = parseInt(color.substring(1, 3), 16) / 255.0;
        var g = parseInt(color.substring(3, 5), 16) / 255.0;
        var b = parseInt(color.substring(5, 7), 16) / 255.0;

        gl.uniform4f(colorLoc, r, g, b, 1.0);

        render();
    };
};


function square(a, b, c, d)
{
    // 사각형을 삼각형 2개로 구성
    points.push(a, b, c);
    points.push(a, c, d);
}


function divideSquare(a, b, c, d, count)
{
    if (count == 0) {

        square(a, b, c, d);

    }
    else {

        // 각 변을 3등분

        var left1  = mix(a, b, 1.0 / 3.0);
        var left2  = mix(a, b, 2.0 / 3.0);

        var right1 = mix(d, c, 1.0 / 3.0);
        var right2 = mix(d, c, 2.0 / 3.0);

        var bottom1 = mix(a, d, 1.0 / 3.0);
        var bottom2 = mix(a, d, 2.0 / 3.0);

        var top1 = mix(b, c, 1.0 / 3.0);
        var top2 = mix(b, c, 2.0 / 3.0);


        // 내부 교차점

        var inner11 =
            mix(left1, right1, 1.0 / 3.0);

        var inner12 =
            mix(left1, right1, 2.0 / 3.0);

        var inner21 =
            mix(left2, right2, 1.0 / 3.0);

        var inner22 =
            mix(left2, right2, 2.0 / 3.0);


        --count;


        // 아래쪽 3개

        divideSquare(
            a, left1, inner11, bottom1,
            count
        );

        divideSquare(
            bottom1, inner11, inner12, bottom2,
            count
        );

        divideSquare(
            bottom2, inner12, right1, d,
            count
        );


        // 가운데 왼쪽

        divideSquare(
            left1, left2, inner21, inner11,
            count
        );


        // 가운데 칸은 제외


        // 가운데 오른쪽

        divideSquare(
            inner12, inner22, right2, right1,
            count
        );


        // 위쪽 3개

        divideSquare(
            left2, b, top1, inner21,
            count
        );

        divideSquare(
            inner21, top1, top2, inner22,
            count
        );

        divideSquare(
            inner22, top2, c, right2,
            count
        );
    }
}


function render()
{
    // 이전 재귀 결과 제거
    points = [];


    // Carpet 정점 생성
    divideSquare(
        vertices[0],
        vertices[1],
        vertices[2],
        vertices[3],
        numTimesToSubdivide
    );


    // 새 정점 데이터를 GPU로 전송
    gl.bindBuffer(
        gl.ARRAY_BUFFER,
        bufferId
    );

    gl.bufferData(
        gl.ARRAY_BUFFER,
        flatten(points),
        gl.STATIC_DRAW
    );


    // 화면 초기화
    gl.clear(gl.COLOR_BUFFER_BIT);


    // 삼각형 렌더링
    gl.drawArrays(
        gl.TRIANGLES,
        0,
        points.length
    );
}