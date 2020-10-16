var __defineProperty = Object.defineProperty;
var __commonJS = (callback, module2) => () => {
  if (!module2) {
    module2 = {exports: {}};
    callback(module2.exports, module2);
  }
  return module2.exports;
};
var __markAsModule = (target) => {
  return __defineProperty(target, "__esModule", {value: true});
};
var __export = (target, all) => {
  __markAsModule(target);
  for (var name in all)
    __defineProperty(target, name, {get: all[name], enumerable: true});
};

// src/facemesh/blazeface.js
var require_blazeface = __commonJS((exports2) => {
  const tf2 = require("@tensorflow/tfjs");
  const NUM_LANDMARKS = 6;
  function generateAnchors(inputSize) {
    const spec = {strides: [inputSize / 16, inputSize / 8], anchors: [2, 6]};
    const anchors = [];
    for (let i = 0; i < spec.strides.length; i++) {
      const stride = spec.strides[i];
      const gridRows = Math.floor((inputSize + stride - 1) / stride);
      const gridCols = Math.floor((inputSize + stride - 1) / stride);
      const anchorsNum = spec.anchors[i];
      for (let gridY = 0; gridY < gridRows; gridY++) {
        const anchorY = stride * (gridY + 0.5);
        for (let gridX = 0; gridX < gridCols; gridX++) {
          const anchorX = stride * (gridX + 0.5);
          for (let n = 0; n < anchorsNum; n++) {
            anchors.push([anchorX, anchorY]);
          }
        }
      }
    }
    return anchors;
  }
  const disposeBox = (box) => {
    box.startEndTensor.dispose();
    box.startPoint.dispose();
    box.endPoint.dispose();
  };
  const createBox = (startEndTensor) => ({
    startEndTensor,
    startPoint: tf2.slice(startEndTensor, [0, 0], [-1, 2]),
    endPoint: tf2.slice(startEndTensor, [0, 2], [-1, 2])
  });
  const scaleBox = (box, factors) => {
    const starts = tf2.mul(box.startPoint, factors);
    const ends = tf2.mul(box.endPoint, factors);
    const newCoordinates = tf2.concat2d([starts, ends], 1);
    return createBox(newCoordinates);
  };
  function decodeBounds(boxOutputs, anchors, inputSize) {
    const boxStarts = tf2.slice(boxOutputs, [0, 1], [-1, 2]);
    const centers = tf2.add(boxStarts, anchors);
    const boxSizes = tf2.slice(boxOutputs, [0, 3], [-1, 2]);
    const boxSizesNormalized = tf2.div(boxSizes, inputSize);
    const centersNormalized = tf2.div(centers, inputSize);
    const halfBoxSize = tf2.div(boxSizesNormalized, 2);
    const starts = tf2.sub(centersNormalized, halfBoxSize);
    const ends = tf2.add(centersNormalized, halfBoxSize);
    const startNormalized = tf2.mul(starts, inputSize);
    const endNormalized = tf2.mul(ends, inputSize);
    const concatAxis = 1;
    return tf2.concat2d([startNormalized, endNormalized], concatAxis);
  }
  function scaleBoxFromPrediction(face, scaleFactor) {
    return tf2.tidy(() => {
      const box = face["box"] ? face["box"] : face;
      return scaleBox(box, scaleFactor).startEndTensor.squeeze();
    });
  }
  class BlazeFaceModel {
    constructor(model, config2) {
      this.blazeFaceModel = model;
      this.width = config2.detector.inputSize;
      this.height = config2.detector.inputSize;
      this.maxFaces = config2.detector.maxFaces;
      this.anchorsData = generateAnchors(config2.detector.inputSize);
      this.anchors = tf2.tensor2d(this.anchorsData);
      this.inputSize = tf2.tensor1d([this.width, this.height]);
      this.iouThreshold = config2.detector.iouThreshold;
      this.scaleFaces = 0.8;
      this.scoreThreshold = config2.detector.scoreThreshold;
    }
    async getBoundingBoxes(inputImage) {
      if (!inputImage || inputImage.isDisposedInternal || inputImage.shape.length !== 4 || inputImage.shape[1] < 1 || inputImage.shape[2] < 1)
        return null;
      const [detectedOutputs, boxes, scores] = tf2.tidy(() => {
        const resizedImage = inputImage.resizeBilinear([this.width, this.height]);
        const normalizedImage = tf2.mul(tf2.sub(resizedImage.div(255), 0.5), 2);
        const batchedPrediction = this.blazeFaceModel.predict(normalizedImage);
        let prediction;
        if (Array.isArray(batchedPrediction)) {
          const sorted = batchedPrediction.sort((a, b) => a.size - b.size);
          const concat384 = tf2.concat([sorted[0], sorted[2]], 2);
          const concat512 = tf2.concat([sorted[1], sorted[3]], 2);
          const concat = tf2.concat([concat512, concat384], 1);
          prediction = concat.squeeze(0);
        } else {
          prediction = batchedPrediction.squeeze();
        }
        const decodedBounds = decodeBounds(prediction, this.anchors, this.inputSize);
        const logits = tf2.slice(prediction, [0, 0], [-1, 1]);
        const scoresOut = tf2.sigmoid(logits).squeeze();
        return [prediction, decodedBounds, scoresOut];
      });
      const boxIndicesTensor = await tf2.image.nonMaxSuppressionAsync(boxes, scores, this.maxFaces, this.iouThreshold, this.scoreThreshold);
      const boxIndices = await boxIndicesTensor.array();
      boxIndicesTensor.dispose();
      let boundingBoxes = boxIndices.map((boxIndex) => tf2.slice(boxes, [boxIndex, 0], [1, -1]));
      boundingBoxes = await Promise.all(boundingBoxes.map(async (boundingBox) => {
        const vals = await boundingBox.array();
        boundingBox.dispose();
        return vals;
      }));
      const annotatedBoxes = [];
      for (let i = 0; i < boundingBoxes.length; i++) {
        const boundingBox = boundingBoxes[i];
        const annotatedBox = tf2.tidy(() => {
          const box = createBox(boundingBox);
          const boxIndex = boxIndices[i];
          const anchor = this.anchorsData[boxIndex];
          const landmarks = tf2.slice(detectedOutputs, [boxIndex, NUM_LANDMARKS - 1], [1, -1]).squeeze().reshape([NUM_LANDMARKS, -1]);
          const probability = tf2.slice(scores, [boxIndex], [1]);
          return {box, landmarks, probability, anchor};
        });
        annotatedBoxes.push(annotatedBox);
      }
      boxes.dispose();
      scores.dispose();
      detectedOutputs.dispose();
      return {
        boxes: annotatedBoxes,
        scaleFactor: [inputImage.shape[2] / this.width, inputImage.shape[1] / this.height]
      };
    }
    async estimateFaces(input) {
      const image = tf2.tidy(() => {
        if (!(input instanceof tf2.Tensor)) {
          input = tf2.browser.fromPixels(input);
        }
        return input.toFloat().expandDims(0);
      });
      const {boxes, scaleFactor} = await this.getBoundingBoxes(image);
      image.dispose();
      return Promise.all(boxes.map(async (face) => {
        const scaledBox = scaleBoxFromPrediction(face, scaleFactor);
        const [landmarkData, boxData, probabilityData] = await Promise.all([face.landmarks, scaledBox, face.probability].map(async (d) => d.array()));
        const anchor = face.anchor;
        const [scaleFactorX, scaleFactorY] = scaleFactor;
        const scaledLandmarks = landmarkData.map((landmark) => [
          (landmark[0] + anchor[0]) * scaleFactorX,
          (landmark[1] + anchor[1]) * scaleFactorY
        ]);
        const normalizedFace = {
          topLeft: boxData.slice(0, 2),
          bottomRight: boxData.slice(2),
          landmarks: scaledLandmarks,
          probability: probabilityData
        };
        disposeBox(face.box);
        face.landmarks.dispose();
        face.probability.dispose();
        scaledBox.dispose();
        return normalizedFace;
      }));
    }
  }
  async function load(config2) {
    const blazeface = await tf2.loadGraphModel(config2.detector.modelPath, {fromTFHub: config2.detector.modelPath.includes("tfhub.dev")});
    const model = new BlazeFaceModel(blazeface, config2);
    return model;
  }
  exports2.load = load;
  exports2.BlazeFaceModel = BlazeFaceModel;
  exports2.disposeBox = disposeBox;
});

// src/facemesh/keypoints.js
var require_keypoints = __commonJS((exports2) => {
  exports2.MESH_ANNOTATIONS = {
    silhouette: [
      10,
      338,
      297,
      332,
      284,
      251,
      389,
      356,
      454,
      323,
      361,
      288,
      397,
      365,
      379,
      378,
      400,
      377,
      152,
      148,
      176,
      149,
      150,
      136,
      172,
      58,
      132,
      93,
      234,
      127,
      162,
      21,
      54,
      103,
      67,
      109
    ],
    lipsUpperOuter: [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291],
    lipsLowerOuter: [146, 91, 181, 84, 17, 314, 405, 321, 375, 291],
    lipsUpperInner: [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308],
    lipsLowerInner: [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308],
    rightEyeUpper0: [246, 161, 160, 159, 158, 157, 173],
    rightEyeLower0: [33, 7, 163, 144, 145, 153, 154, 155, 133],
    rightEyeUpper1: [247, 30, 29, 27, 28, 56, 190],
    rightEyeLower1: [130, 25, 110, 24, 23, 22, 26, 112, 243],
    rightEyeUpper2: [113, 225, 224, 223, 222, 221, 189],
    rightEyeLower2: [226, 31, 228, 229, 230, 231, 232, 233, 244],
    rightEyeLower3: [143, 111, 117, 118, 119, 120, 121, 128, 245],
    rightEyebrowUpper: [156, 70, 63, 105, 66, 107, 55, 193],
    rightEyebrowLower: [35, 124, 46, 53, 52, 65],
    rightEyeIris: [473, 474, 475, 476, 477],
    leftEyeUpper0: [466, 388, 387, 386, 385, 384, 398],
    leftEyeLower0: [263, 249, 390, 373, 374, 380, 381, 382, 362],
    leftEyeUpper1: [467, 260, 259, 257, 258, 286, 414],
    leftEyeLower1: [359, 255, 339, 254, 253, 252, 256, 341, 463],
    leftEyeUpper2: [342, 445, 444, 443, 442, 441, 413],
    leftEyeLower2: [446, 261, 448, 449, 450, 451, 452, 453, 464],
    leftEyeLower3: [372, 340, 346, 347, 348, 349, 350, 357, 465],
    leftEyebrowUpper: [383, 300, 293, 334, 296, 336, 285, 417],
    leftEyebrowLower: [265, 353, 276, 283, 282, 295],
    leftEyeIris: [468, 469, 470, 471, 472],
    midwayBetweenEyes: [168],
    noseTip: [1],
    noseBottom: [2],
    noseRightCorner: [98],
    noseLeftCorner: [327],
    rightCheek: [205],
    leftCheek: [425]
  };
  exports2.MESH_TO_IRIS_INDICES_MAP = [
    {key: "EyeUpper0", indices: [9, 10, 11, 12, 13, 14, 15]},
    {key: "EyeUpper1", indices: [25, 26, 27, 28, 29, 30, 31]},
    {key: "EyeUpper2", indices: [41, 42, 43, 44, 45, 46, 47]},
    {key: "EyeLower0", indices: [0, 1, 2, 3, 4, 5, 6, 7, 8]},
    {key: "EyeLower1", indices: [16, 17, 18, 19, 20, 21, 22, 23, 24]},
    {key: "EyeLower2", indices: [32, 33, 34, 35, 36, 37, 38, 39, 40]},
    {key: "EyeLower3", indices: [54, 55, 56, 57, 58, 59, 60, 61, 62]},
    {key: "EyebrowUpper", indices: [63, 64, 65, 66, 67, 68, 69, 70]},
    {key: "EyebrowLower", indices: [48, 49, 50, 51, 52, 53]}
  ];
});

// src/facemesh/box.js
var require_box = __commonJS((exports2) => {
  const tf2 = require("@tensorflow/tfjs");
  function scaleBoxCoordinates(box, factor) {
    const startPoint = [box.startPoint[0] * factor[0], box.startPoint[1] * factor[1]];
    const endPoint = [box.endPoint[0] * factor[0], box.endPoint[1] * factor[1]];
    return {startPoint, endPoint};
  }
  exports2.scaleBoxCoordinates = scaleBoxCoordinates;
  function getBoxSize(box) {
    return [
      Math.abs(box.endPoint[0] - box.startPoint[0]),
      Math.abs(box.endPoint[1] - box.startPoint[1])
    ];
  }
  exports2.getBoxSize = getBoxSize;
  function getBoxCenter(box) {
    return [
      box.startPoint[0] + (box.endPoint[0] - box.startPoint[0]) / 2,
      box.startPoint[1] + (box.endPoint[1] - box.startPoint[1]) / 2
    ];
  }
  exports2.getBoxCenter = getBoxCenter;
  function cutBoxFromImageAndResize(box, image, cropSize) {
    const h = image.shape[1];
    const w = image.shape[2];
    const boxes = [[
      box.startPoint[1] / h,
      box.startPoint[0] / w,
      box.endPoint[1] / h,
      box.endPoint[0] / w
    ]];
    return tf2.image.cropAndResize(image, boxes, [0], cropSize);
  }
  exports2.cutBoxFromImageAndResize = cutBoxFromImageAndResize;
  function enlargeBox(box, factor = 1.5) {
    const center = getBoxCenter(box);
    const size = getBoxSize(box);
    const newHalfSize = [factor * size[0] / 2, factor * size[1] / 2];
    const startPoint = [center[0] - newHalfSize[0], center[1] - newHalfSize[1]];
    const endPoint = [center[0] + newHalfSize[0], center[1] + newHalfSize[1]];
    return {startPoint, endPoint, landmarks: box.landmarks};
  }
  exports2.enlargeBox = enlargeBox;
  function squarifyBox(box) {
    const centers = getBoxCenter(box);
    const size = getBoxSize(box);
    const maxEdge = Math.max(...size);
    const halfSize = maxEdge / 2;
    const startPoint = [centers[0] - halfSize, centers[1] - halfSize];
    const endPoint = [centers[0] + halfSize, centers[1] + halfSize];
    return {startPoint, endPoint, landmarks: box.landmarks};
  }
  exports2.squarifyBox = squarifyBox;
});

// src/facemesh/util.js
var require_util = __commonJS((exports2) => {
  exports2.IDENTITY_MATRIX = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  function normalizeRadians(angle) {
    return angle - 2 * Math.PI * Math.floor((angle + Math.PI) / (2 * Math.PI));
  }
  exports2.normalizeRadians = normalizeRadians;
  function computeRotation(point1, point2) {
    const radians = Math.PI / 2 - Math.atan2(-(point2[1] - point1[1]), point2[0] - point1[0]);
    return normalizeRadians(radians);
  }
  exports2.computeRotation = computeRotation;
  function radToDegrees(rad) {
    return rad * 180 / Math.PI;
  }
  exports2.radToDegrees = radToDegrees;
  function buildTranslationMatrix(x, y) {
    return [[1, 0, x], [0, 1, y], [0, 0, 1]];
  }
  function dot(v1, v2) {
    let product = 0;
    for (let i = 0; i < v1.length; i++) {
      product += v1[i] * v2[i];
    }
    return product;
  }
  exports2.dot = dot;
  function getColumnFrom2DArr(arr, columnIndex) {
    const column = [];
    for (let i = 0; i < arr.length; i++) {
      column.push(arr[i][columnIndex]);
    }
    return column;
  }
  exports2.getColumnFrom2DArr = getColumnFrom2DArr;
  function multiplyTransformMatrices(mat1, mat2) {
    const product = [];
    const size = mat1.length;
    for (let row = 0; row < size; row++) {
      product.push([]);
      for (let col = 0; col < size; col++) {
        product[row].push(dot(mat1[row], getColumnFrom2DArr(mat2, col)));
      }
    }
    return product;
  }
  function buildRotationMatrix(rotation, center) {
    const cosA = Math.cos(rotation);
    const sinA = Math.sin(rotation);
    const rotationMatrix = [[cosA, -sinA, 0], [sinA, cosA, 0], [0, 0, 1]];
    const translationMatrix = buildTranslationMatrix(center[0], center[1]);
    const translationTimesRotation = multiplyTransformMatrices(translationMatrix, rotationMatrix);
    const negativeTranslationMatrix = buildTranslationMatrix(-center[0], -center[1]);
    return multiplyTransformMatrices(translationTimesRotation, negativeTranslationMatrix);
  }
  exports2.buildRotationMatrix = buildRotationMatrix;
  function invertTransformMatrix(matrix) {
    const rotationComponent = [[matrix[0][0], matrix[1][0]], [matrix[0][1], matrix[1][1]]];
    const translationComponent = [matrix[0][2], matrix[1][2]];
    const invertedTranslation = [
      -dot(rotationComponent[0], translationComponent),
      -dot(rotationComponent[1], translationComponent)
    ];
    return [
      rotationComponent[0].concat(invertedTranslation[0]),
      rotationComponent[1].concat(invertedTranslation[1]),
      [0, 0, 1]
    ];
  }
  exports2.invertTransformMatrix = invertTransformMatrix;
  function rotatePoint(homogeneousCoordinate, rotationMatrix) {
    return [
      dot(homogeneousCoordinate, rotationMatrix[0]),
      dot(homogeneousCoordinate, rotationMatrix[1])
    ];
  }
  exports2.rotatePoint = rotatePoint;
  function xyDistanceBetweenPoints(a, b) {
    return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2);
  }
  exports2.xyDistanceBetweenPoints = xyDistanceBetweenPoints;
});

// src/facemesh/pipeline.js
var require_pipeline = __commonJS((exports2) => {
  const tf2 = require("@tensorflow/tfjs");
  const bounding = require_box();
  const keypoints = require_keypoints();
  const util = require_util();
  const LANDMARKS_COUNT = 468;
  const UPDATE_REGION_OF_INTEREST_IOU_THRESHOLD = 0.25;
  const MESH_MOUTH_INDEX = 13;
  const MESH_KEYPOINTS_LINE_OF_SYMMETRY_INDICES = [MESH_MOUTH_INDEX, keypoints.MESH_ANNOTATIONS["midwayBetweenEyes"][0]];
  const BLAZEFACE_MOUTH_INDEX = 3;
  const BLAZEFACE_NOSE_INDEX = 2;
  const BLAZEFACE_KEYPOINTS_LINE_OF_SYMMETRY_INDICES = [BLAZEFACE_MOUTH_INDEX, BLAZEFACE_NOSE_INDEX];
  const LEFT_EYE_OUTLINE = keypoints.MESH_ANNOTATIONS["leftEyeLower0"];
  const LEFT_EYE_BOUNDS = [LEFT_EYE_OUTLINE[0], LEFT_EYE_OUTLINE[LEFT_EYE_OUTLINE.length - 1]];
  const RIGHT_EYE_OUTLINE = keypoints.MESH_ANNOTATIONS["rightEyeLower0"];
  const RIGHT_EYE_BOUNDS = [RIGHT_EYE_OUTLINE[0], RIGHT_EYE_OUTLINE[RIGHT_EYE_OUTLINE.length - 1]];
  const IRIS_UPPER_CENTER_INDEX = 3;
  const IRIS_LOWER_CENTER_INDEX = 4;
  const IRIS_IRIS_INDEX = 71;
  const IRIS_NUM_COORDINATES = 76;
  function replaceRawCoordinates(rawCoords, newCoords, prefix, keys) {
    for (let i = 0; i < keypoints.MESH_TO_IRIS_INDICES_MAP.length; i++) {
      const {key, indices} = keypoints.MESH_TO_IRIS_INDICES_MAP[i];
      const originalIndices = keypoints.MESH_ANNOTATIONS[`${prefix}${key}`];
      const shouldReplaceAllKeys = keys == null;
      if (shouldReplaceAllKeys || keys.includes(key)) {
        for (let j = 0; j < indices.length; j++) {
          const index = indices[j];
          rawCoords[originalIndices[j]] = [
            newCoords[index][0],
            newCoords[index][1],
            (newCoords[index][2] + rawCoords[originalIndices[j]][2]) / 2
          ];
        }
      }
    }
  }
  class Pipeline {
    constructor(boundingBoxDetector, meshDetector, irisModel, config2) {
      this.regionsOfInterest = [];
      this.runsWithoutFaceDetector = 0;
      this.boundingBoxDetector = boundingBoxDetector;
      this.meshDetector = meshDetector;
      this.irisModel = irisModel;
      this.meshWidth = config2.mesh.inputSize;
      this.meshHeight = config2.mesh.inputSize;
      this.irisSize = config2.iris.inputSize;
      this.irisEnlarge = config2.iris.enlargeFactor;
    }
    transformRawCoords(rawCoords, box, angle, rotationMatrix) {
      const boxSize = bounding.getBoxSize({startPoint: box.startPoint, endPoint: box.endPoint});
      const scaleFactor = [boxSize[0] / this.meshWidth, boxSize[1] / this.meshHeight];
      const coordsScaled = rawCoords.map((coord) => [
        scaleFactor[0] * (coord[0] - this.meshWidth / 2),
        scaleFactor[1] * (coord[1] - this.meshHeight / 2),
        coord[2]
      ]);
      const coordsRotationMatrix = util.buildRotationMatrix(angle, [0, 0]);
      const coordsRotated = coordsScaled.map((coord) => [...util.rotatePoint(coord, coordsRotationMatrix), coord[2]]);
      const inverseRotationMatrix = util.invertTransformMatrix(rotationMatrix);
      const boxCenter = [...bounding.getBoxCenter({startPoint: box.startPoint, endPoint: box.endPoint}), 1];
      const originalBoxCenter = [
        util.dot(boxCenter, inverseRotationMatrix[0]),
        util.dot(boxCenter, inverseRotationMatrix[1])
      ];
      return coordsRotated.map((coord) => [
        coord[0] + originalBoxCenter[0],
        coord[1] + originalBoxCenter[1],
        coord[2]
      ]);
    }
    getLeftToRightEyeDepthDifference(rawCoords) {
      const leftEyeZ = rawCoords[LEFT_EYE_BOUNDS[0]][2];
      const rightEyeZ = rawCoords[RIGHT_EYE_BOUNDS[0]][2];
      return leftEyeZ - rightEyeZ;
    }
    getEyeBox(rawCoords, face, eyeInnerCornerIndex, eyeOuterCornerIndex, flip = false) {
      const box = bounding.squarifyBox(bounding.enlargeBox(this.calculateLandmarksBoundingBox([rawCoords[eyeInnerCornerIndex], rawCoords[eyeOuterCornerIndex]]), this.irisEnlarge));
      const boxSize = bounding.getBoxSize(box);
      let crop = tf2.image.cropAndResize(face, [[
        box.startPoint[1] / this.meshHeight,
        box.startPoint[0] / this.meshWidth,
        box.endPoint[1] / this.meshHeight,
        box.endPoint[0] / this.meshWidth
      ]], [0], [this.irisSize, this.irisSize]);
      if (flip) {
        crop = tf2.image.flipLeftRight(crop);
      }
      return {box, boxSize, crop};
    }
    getEyeCoords(eyeData, eyeBox, eyeBoxSize, flip = false) {
      const eyeRawCoords = [];
      for (let i = 0; i < IRIS_NUM_COORDINATES; i++) {
        const x = eyeData[i * 3];
        const y = eyeData[i * 3 + 1];
        const z = eyeData[i * 3 + 2];
        eyeRawCoords.push([
          (flip ? 1 - x / this.irisSize : x / this.irisSize) * eyeBoxSize[0] + eyeBox.startPoint[0],
          y / this.irisSize * eyeBoxSize[1] + eyeBox.startPoint[1],
          z
        ]);
      }
      return {rawCoords: eyeRawCoords, iris: eyeRawCoords.slice(IRIS_IRIS_INDEX)};
    }
    getAdjustedIrisCoords(rawCoords, irisCoords, direction) {
      const upperCenterZ = rawCoords[keypoints.MESH_ANNOTATIONS[`${direction}EyeUpper0`][IRIS_UPPER_CENTER_INDEX]][2];
      const lowerCenterZ = rawCoords[keypoints.MESH_ANNOTATIONS[`${direction}EyeLower0`][IRIS_LOWER_CENTER_INDEX]][2];
      const averageZ = (upperCenterZ + lowerCenterZ) / 2;
      return irisCoords.map((coord, i) => {
        let z = averageZ;
        if (i === 2) {
          z = upperCenterZ;
        } else if (i === 4) {
          z = lowerCenterZ;
        }
        return [coord[0], coord[1], z];
      });
    }
    async predict(input, config2) {
      this.skipFrames = config2.detector.skipFrames;
      this.maxFaces = config2.detector.maxFaces;
      if (this.shouldUpdateRegionsOfInterest()) {
        const {boxes, scaleFactor} = await this.boundingBoxDetector.getBoundingBoxes(input);
        if (boxes.length === 0) {
          this.regionsOfInterest = [];
          return null;
        }
        const scaledBoxes = boxes.map((prediction) => {
          const predictionBox = {
            startPoint: prediction.box.startPoint.squeeze().arraySync(),
            endPoint: prediction.box.endPoint.squeeze().arraySync()
          };
          prediction.box.startPoint.dispose();
          prediction.box.endPoint.dispose();
          const scaledBox = bounding.scaleBoxCoordinates(predictionBox, scaleFactor);
          const enlargedBox = bounding.enlargeBox(scaledBox);
          const landmarks = prediction.landmarks.arraySync();
          prediction.landmarks.dispose();
          prediction.probability.dispose();
          return {...enlargedBox, landmarks};
        });
        this.updateRegionsOfInterest(scaledBoxes);
        this.runsWithoutFaceDetector = 0;
      } else {
        this.runsWithoutFaceDetector++;
      }
      const results = tf2.tidy(() => this.regionsOfInterest.map((box, i) => {
        let angle = 0;
        const boxLandmarksFromMeshModel = box.landmarks.length >= LANDMARKS_COUNT;
        let [indexOfMouth, indexOfForehead] = MESH_KEYPOINTS_LINE_OF_SYMMETRY_INDICES;
        if (boxLandmarksFromMeshModel === false) {
          [indexOfMouth, indexOfForehead] = BLAZEFACE_KEYPOINTS_LINE_OF_SYMMETRY_INDICES;
        }
        angle = util.computeRotation(box.landmarks[indexOfMouth], box.landmarks[indexOfForehead]);
        const faceCenter = bounding.getBoxCenter({startPoint: box.startPoint, endPoint: box.endPoint});
        const faceCenterNormalized = [faceCenter[0] / input.shape[2], faceCenter[1] / input.shape[1]];
        let rotatedImage = input;
        let rotationMatrix = util.IDENTITY_MATRIX;
        if (angle !== 0) {
          rotatedImage = tf2.image.rotateWithOffset(input, angle, 0, faceCenterNormalized);
          rotationMatrix = util.buildRotationMatrix(-angle, faceCenter);
        }
        const boxCPU = {startPoint: box.startPoint, endPoint: box.endPoint};
        const face = bounding.cutBoxFromImageAndResize(boxCPU, rotatedImage, [this.meshHeight, this.meshWidth]).div(255);
        const [, flag, coords] = this.meshDetector.predict(face);
        const coordsReshaped = tf2.reshape(coords, [-1, 3]);
        let rawCoords = coordsReshaped.arraySync();
        if (config2.iris.enabled) {
          const {box: leftEyeBox, boxSize: leftEyeBoxSize, crop: leftEyeCrop} = this.getEyeBox(rawCoords, face, LEFT_EYE_BOUNDS[0], LEFT_EYE_BOUNDS[1], true);
          const {box: rightEyeBox, boxSize: rightEyeBoxSize, crop: rightEyeCrop} = this.getEyeBox(rawCoords, face, RIGHT_EYE_BOUNDS[0], RIGHT_EYE_BOUNDS[1]);
          const eyePredictions = this.irisModel.predict(tf2.concat([leftEyeCrop, rightEyeCrop]));
          const eyePredictionsData = eyePredictions.dataSync();
          eyePredictions.dispose();
          const leftEyeData = eyePredictionsData.slice(0, IRIS_NUM_COORDINATES * 3);
          const {rawCoords: leftEyeRawCoords, iris: leftIrisRawCoords} = this.getEyeCoords(leftEyeData, leftEyeBox, leftEyeBoxSize, true);
          const rightEyeData = eyePredictionsData.slice(IRIS_NUM_COORDINATES * 3);
          const {rawCoords: rightEyeRawCoords, iris: rightIrisRawCoords} = this.getEyeCoords(rightEyeData, rightEyeBox, rightEyeBoxSize);
          const leftToRightEyeDepthDifference = this.getLeftToRightEyeDepthDifference(rawCoords);
          if (Math.abs(leftToRightEyeDepthDifference) < 30) {
            replaceRawCoordinates(rawCoords, leftEyeRawCoords, "left");
            replaceRawCoordinates(rawCoords, rightEyeRawCoords, "right");
          } else if (leftToRightEyeDepthDifference < 1) {
            replaceRawCoordinates(rawCoords, leftEyeRawCoords, "left", ["EyeUpper0", "EyeLower0"]);
          } else {
            replaceRawCoordinates(rawCoords, rightEyeRawCoords, "right", ["EyeUpper0", "EyeLower0"]);
          }
          const adjustedLeftIrisCoords = this.getAdjustedIrisCoords(rawCoords, leftIrisRawCoords, "left");
          const adjustedRightIrisCoords = this.getAdjustedIrisCoords(rawCoords, rightIrisRawCoords, "right");
          rawCoords = rawCoords.concat(adjustedLeftIrisCoords).concat(adjustedRightIrisCoords);
        }
        const transformedCoordsData = this.transformRawCoords(rawCoords, box, angle, rotationMatrix);
        tf2.dispose(rawCoords);
        const landmarksBox = bounding.enlargeBox(this.calculateLandmarksBoundingBox(transformedCoordsData));
        if (config2.mesh.enabled) {
          const transformedCoords = tf2.tensor2d(transformedCoordsData);
          this.regionsOfInterest[i] = {...landmarksBox, landmarks: transformedCoords.arraySync()};
          const prediction2 = {
            coords: transformedCoords,
            box: landmarksBox,
            confidence: flag.squeeze(),
            image: face
          };
          return prediction2;
        }
        const prediction = {
          coords: null,
          box: landmarksBox,
          confidence: flag.squeeze(),
          image: face
        };
        return prediction;
      }));
      return results;
    }
    updateRegionsOfInterest(boxes) {
      for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i];
        const previousBox = this.regionsOfInterest[i];
        let iou = 0;
        if (previousBox && previousBox.startPoint) {
          const [boxStartX, boxStartY] = box.startPoint;
          const [boxEndX, boxEndY] = box.endPoint;
          const [previousBoxStartX, previousBoxStartY] = previousBox.startPoint;
          const [previousBoxEndX, previousBoxEndY] = previousBox.endPoint;
          const xStartMax = Math.max(boxStartX, previousBoxStartX);
          const yStartMax = Math.max(boxStartY, previousBoxStartY);
          const xEndMin = Math.min(boxEndX, previousBoxEndX);
          const yEndMin = Math.min(boxEndY, previousBoxEndY);
          const intersection = (xEndMin - xStartMax) * (yEndMin - yStartMax);
          const boxArea = (boxEndX - boxStartX) * (boxEndY - boxStartY);
          const previousBoxArea = (previousBoxEndX - previousBoxStartX) * (previousBoxEndY - boxStartY);
          iou = intersection / (boxArea + previousBoxArea - intersection);
        }
        if (iou < UPDATE_REGION_OF_INTEREST_IOU_THRESHOLD) {
          this.regionsOfInterest[i] = box;
        }
      }
      this.regionsOfInterest = this.regionsOfInterest.slice(0, boxes.length);
    }
    clearRegionOfInterest(index) {
      if (this.regionsOfInterest[index] != null) {
        this.regionsOfInterest = [
          ...this.regionsOfInterest.slice(0, index),
          ...this.regionsOfInterest.slice(index + 1)
        ];
      }
    }
    shouldUpdateRegionsOfInterest() {
      const roisCount = this.regionsOfInterest.length;
      const noROIs = roisCount === 0;
      if (this.maxFaces === 1 || noROIs) {
        return noROIs;
      }
      return roisCount !== this.maxFaces && this.runsWithoutFaceDetector >= this.skipFrames;
    }
    calculateLandmarksBoundingBox(landmarks) {
      const xs = landmarks.map((d) => d[0]);
      const ys = landmarks.map((d) => d[1]);
      const startPoint = [Math.min(...xs), Math.min(...ys)];
      const endPoint = [Math.max(...xs), Math.max(...ys)];
      return {startPoint, endPoint};
    }
  }
  exports2.Pipeline = Pipeline;
});

// src/facemesh/uvcoords.js
var require_uvcoords = __commonJS((exports2) => {
  exports2.UV_COORDS = [
    [0.499976992607117, 0.652534008026123],
    [0.500025987625122, 0.547487020492554],
    [0.499974012374878, 0.602371990680695],
    [0.482113003730774, 0.471979022026062],
    [0.500150978565216, 0.527155995368958],
    [0.499909996986389, 0.498252987861633],
    [0.499523013830185, 0.40106201171875],
    [0.289712011814117, 0.380764007568359],
    [0.499954998493195, 0.312398016452789],
    [0.499987006187439, 0.269918978214264],
    [0.500023007392883, 0.107050001621246],
    [0.500023007392883, 0.666234016418457],
    [0.5000159740448, 0.679224014282227],
    [0.500023007392883, 0.692348003387451],
    [0.499976992607117, 0.695277988910675],
    [0.499976992607117, 0.70593398809433],
    [0.499976992607117, 0.719385027885437],
    [0.499976992607117, 0.737019002437592],
    [0.499967992305756, 0.781370997428894],
    [0.499816000461578, 0.562981009483337],
    [0.473773002624512, 0.573909997940063],
    [0.104906998574734, 0.254140973091125],
    [0.365929991006851, 0.409575998783112],
    [0.338757991790771, 0.41302502155304],
    [0.311120003461838, 0.409460008144379],
    [0.274657994508743, 0.389131009578705],
    [0.393361985683441, 0.403706014156342],
    [0.345234006643295, 0.344011008739471],
    [0.370094001293182, 0.346076011657715],
    [0.319321990013123, 0.347265005111694],
    [0.297903001308441, 0.353591024875641],
    [0.24779200553894, 0.410809993743896],
    [0.396889001131058, 0.842755019664764],
    [0.280097991228104, 0.375599980354309],
    [0.106310002505779, 0.399955987930298],
    [0.2099249958992, 0.391353011131287],
    [0.355807989835739, 0.534406006336212],
    [0.471751004457474, 0.65040397644043],
    [0.474155008792877, 0.680191993713379],
    [0.439785003662109, 0.657229006290436],
    [0.414617002010345, 0.66654098033905],
    [0.450374007225037, 0.680860996246338],
    [0.428770989179611, 0.682690978050232],
    [0.374971002340317, 0.727805018424988],
    [0.486716985702515, 0.547628998756409],
    [0.485300987958908, 0.527395009994507],
    [0.257764995098114, 0.314490020275116],
    [0.401223003864288, 0.455172002315521],
    [0.429818987846375, 0.548614978790283],
    [0.421351999044418, 0.533740997314453],
    [0.276895999908447, 0.532056987285614],
    [0.483370006084442, 0.499586999416351],
    [0.33721199631691, 0.282882988452911],
    [0.296391993761063, 0.293242990970612],
    [0.169294998049736, 0.193813979625702],
    [0.447580009698868, 0.302609980106354],
    [0.392390012741089, 0.353887975215912],
    [0.354490011930466, 0.696784019470215],
    [0.067304998636246, 0.730105042457581],
    [0.442739009857178, 0.572826027870178],
    [0.457098007202148, 0.584792017936707],
    [0.381974011659622, 0.694710969924927],
    [0.392388999462128, 0.694203019142151],
    [0.277076005935669, 0.271932005882263],
    [0.422551989555359, 0.563233017921448],
    [0.385919004678726, 0.281364023685455],
    [0.383103013038635, 0.255840003490448],
    [0.331431001424789, 0.119714021682739],
    [0.229923993349075, 0.232002973556519],
    [0.364500999450684, 0.189113974571228],
    [0.229622006416321, 0.299540996551514],
    [0.173287004232407, 0.278747975826263],
    [0.472878992557526, 0.666198015213013],
    [0.446828007698059, 0.668527007102966],
    [0.422762006521225, 0.673889994621277],
    [0.445307999849319, 0.580065965652466],
    [0.388103008270264, 0.693961024284363],
    [0.403039008378983, 0.706539988517761],
    [0.403629004955292, 0.693953037261963],
    [0.460041999816895, 0.557139039039612],
    [0.431158006191254, 0.692366003990173],
    [0.452181994915009, 0.692366003990173],
    [0.475387006998062, 0.692366003990173],
    [0.465828001499176, 0.779190003871918],
    [0.472328990697861, 0.736225962638855],
    [0.473087012767792, 0.717857003211975],
    [0.473122000694275, 0.704625964164734],
    [0.473033010959625, 0.695277988910675],
    [0.427942007780075, 0.695277988910675],
    [0.426479011774063, 0.703539967536926],
    [0.423162013292313, 0.711845993995667],
    [0.4183090031147, 0.720062971115112],
    [0.390094995498657, 0.639572978019714],
    [0.013953999616206, 0.560034036636353],
    [0.499913990497589, 0.58014702796936],
    [0.413199990987778, 0.69539999961853],
    [0.409626007080078, 0.701822996139526],
    [0.468080013990402, 0.601534962654114],
    [0.422728985548019, 0.585985004901886],
    [0.463079988956451, 0.593783974647522],
    [0.37211999297142, 0.47341400384903],
    [0.334562003612518, 0.496073007583618],
    [0.411671012639999, 0.546965003013611],
    [0.242175996303558, 0.14767599105835],
    [0.290776997804642, 0.201445996761322],
    [0.327338010072708, 0.256527006626129],
    [0.399509996175766, 0.748921036720276],
    [0.441727995872498, 0.261676013469696],
    [0.429764986038208, 0.187834024429321],
    [0.412198007106781, 0.108901023864746],
    [0.288955003023148, 0.398952007293701],
    [0.218936994671822, 0.435410976409912],
    [0.41278201341629, 0.398970007896423],
    [0.257135003805161, 0.355440020561218],
    [0.427684992551804, 0.437960982322693],
    [0.448339998722076, 0.536936044692993],
    [0.178560003638268, 0.45755398273468],
    [0.247308000922203, 0.457193970680237],
    [0.286267012357712, 0.467674970626831],
    [0.332827985286713, 0.460712015628815],
    [0.368755996227264, 0.447206974029541],
    [0.398963987827301, 0.432654976844788],
    [0.476410001516342, 0.405806005001068],
    [0.189241006970406, 0.523923993110657],
    [0.228962004184723, 0.348950982093811],
    [0.490725994110107, 0.562400996685028],
    [0.404670000076294, 0.485132992267609],
    [0.019469000399113, 0.401564002037048],
    [0.426243007183075, 0.420431017875671],
    [0.396993011236191, 0.548797011375427],
    [0.266469985246658, 0.376977026462555],
    [0.439121007919312, 0.51895797252655],
    [0.032313998788595, 0.644356966018677],
    [0.419054001569748, 0.387154996395111],
    [0.462783008813858, 0.505746960639954],
    [0.238978996872902, 0.779744982719421],
    [0.198220998048782, 0.831938028335571],
    [0.107550002634525, 0.540755033493042],
    [0.183610007166862, 0.740257024765015],
    [0.134409993886948, 0.333683013916016],
    [0.385764002799988, 0.883153975009918],
    [0.490967005491257, 0.579378008842468],
    [0.382384985685349, 0.508572995662689],
    [0.174399003386497, 0.397670984268188],
    [0.318785011768341, 0.39623498916626],
    [0.343364000320435, 0.400596976280212],
    [0.396100014448166, 0.710216999053955],
    [0.187885001301765, 0.588537991046906],
    [0.430987000465393, 0.944064974784851],
    [0.318993002176285, 0.898285031318665],
    [0.266247987747192, 0.869701027870178],
    [0.500023007392883, 0.190576016902924],
    [0.499976992607117, 0.954452991485596],
    [0.366169989109039, 0.398822009563446],
    [0.393207013607025, 0.39553701877594],
    [0.410373002290726, 0.391080021858215],
    [0.194993004202843, 0.342101991176605],
    [0.388664990663528, 0.362284004688263],
    [0.365961998701096, 0.355970978736877],
    [0.343364000320435, 0.355356991291046],
    [0.318785011768341, 0.35834002494812],
    [0.301414996385574, 0.363156020641327],
    [0.058132998645306, 0.319076001644135],
    [0.301414996385574, 0.387449026107788],
    [0.499987989664078, 0.618434011936188],
    [0.415838003158569, 0.624195992946625],
    [0.445681989192963, 0.566076993942261],
    [0.465844005346298, 0.620640993118286],
    [0.49992299079895, 0.351523995399475],
    [0.288718998432159, 0.819945991039276],
    [0.335278987884521, 0.852819979190826],
    [0.440512001514435, 0.902418971061707],
    [0.128294005990028, 0.791940987110138],
    [0.408771991729736, 0.373893976211548],
    [0.455606997013092, 0.451801002025604],
    [0.499877005815506, 0.908990025520325],
    [0.375436991453171, 0.924192011356354],
    [0.11421000212431, 0.615022003650665],
    [0.448662012815475, 0.695277988910675],
    [0.4480200111866, 0.704632043838501],
    [0.447111994028091, 0.715808033943176],
    [0.444831997156143, 0.730794012546539],
    [0.430011987686157, 0.766808986663818],
    [0.406787008047104, 0.685672998428345],
    [0.400738000869751, 0.681069016456604],
    [0.392399996519089, 0.677703022956848],
    [0.367855995893478, 0.663918972015381],
    [0.247923001646996, 0.601333022117615],
    [0.452769994735718, 0.420849978923798],
    [0.43639200925827, 0.359887003898621],
    [0.416164010763168, 0.368713974952698],
    [0.413385987281799, 0.692366003990173],
    [0.228018000721931, 0.683571994304657],
    [0.468268007040024, 0.352671027183533],
    [0.411361992359161, 0.804327011108398],
    [0.499989002943039, 0.469825029373169],
    [0.479153990745544, 0.442654013633728],
    [0.499974012374878, 0.439637005329132],
    [0.432112008333206, 0.493588984012604],
    [0.499886006116867, 0.866917014122009],
    [0.49991300702095, 0.821729004383087],
    [0.456548988819122, 0.819200992584229],
    [0.344549000263214, 0.745438992977142],
    [0.37890899181366, 0.574010014533997],
    [0.374292999505997, 0.780184984207153],
    [0.319687992334366, 0.570737957954407],
    [0.357154995203018, 0.604269981384277],
    [0.295284003019333, 0.621580958366394],
    [0.447750002145767, 0.862477004528046],
    [0.410986006259918, 0.508723020553589],
    [0.31395098567009, 0.775308012962341],
    [0.354128003120422, 0.812552988529205],
    [0.324548006057739, 0.703992962837219],
    [0.189096003770828, 0.646299958229065],
    [0.279776990413666, 0.71465802192688],
    [0.1338230073452, 0.682700991630554],
    [0.336768001317978, 0.644733011722565],
    [0.429883986711502, 0.466521978378296],
    [0.455527991056442, 0.548622965812683],
    [0.437114000320435, 0.558896005153656],
    [0.467287987470627, 0.529924988746643],
    [0.414712011814117, 0.335219979286194],
    [0.37704598903656, 0.322777986526489],
    [0.344107985496521, 0.320150971412659],
    [0.312875986099243, 0.32233202457428],
    [0.283526003360748, 0.333190023899078],
    [0.241245999932289, 0.382785975933075],
    [0.102986000478268, 0.468762993812561],
    [0.267612010240555, 0.424560010433197],
    [0.297879010438919, 0.433175981044769],
    [0.333433985710144, 0.433878004550934],
    [0.366427004337311, 0.426115989685059],
    [0.396012008190155, 0.416696012020111],
    [0.420121014118195, 0.41022801399231],
    [0.007561000064015, 0.480777025222778],
    [0.432949006557465, 0.569517970085144],
    [0.458638995885849, 0.479089021682739],
    [0.473466008901596, 0.545744001865387],
    [0.476087987422943, 0.563830018043518],
    [0.468472003936768, 0.555056989192963],
    [0.433990985155106, 0.582361996173859],
    [0.483518004417419, 0.562983989715576],
    [0.482482999563217, 0.57784903049469],
    [0.42645001411438, 0.389798998832703],
    [0.438998997211456, 0.39649498462677],
    [0.450067013502121, 0.400434017181396],
    [0.289712011814117, 0.368252992630005],
    [0.276670008897781, 0.363372981548309],
    [0.517862021923065, 0.471948027610779],
    [0.710287988185883, 0.380764007568359],
    [0.526226997375488, 0.573909997940063],
    [0.895093023777008, 0.254140973091125],
    [0.634069979190826, 0.409575998783112],
    [0.661242008209229, 0.41302502155304],
    [0.688880026340485, 0.409460008144379],
    [0.725341975688934, 0.389131009578705],
    [0.606630027294159, 0.40370500087738],
    [0.654766023159027, 0.344011008739471],
    [0.629905998706818, 0.346076011657715],
    [0.680678009986877, 0.347265005111694],
    [0.702096998691559, 0.353591024875641],
    [0.75221198797226, 0.410804986953735],
    [0.602918028831482, 0.842862963676453],
    [0.719901978969574, 0.375599980354309],
    [0.893692970275879, 0.399959981441498],
    [0.790081977844238, 0.391354024410248],
    [0.643998026847839, 0.534487962722778],
    [0.528249025344849, 0.65040397644043],
    [0.525849997997284, 0.680191040039062],
    [0.560214996337891, 0.657229006290436],
    [0.585384011268616, 0.66654098033905],
    [0.549625992774963, 0.680860996246338],
    [0.57122802734375, 0.682691991329193],
    [0.624852001667023, 0.72809898853302],
    [0.513050019741058, 0.547281980514526],
    [0.51509702205658, 0.527251958847046],
    [0.742246985435486, 0.314507007598877],
    [0.598631024360657, 0.454979002475739],
    [0.570338010787964, 0.548575043678284],
    [0.578631997108459, 0.533622980117798],
    [0.723087012767792, 0.532054007053375],
    [0.516445994377136, 0.499638974666595],
    [0.662801027297974, 0.282917976379395],
    [0.70362401008606, 0.293271005153656],
    [0.830704987049103, 0.193813979625702],
    [0.552385985851288, 0.302568018436432],
    [0.607609987258911, 0.353887975215912],
    [0.645429015159607, 0.696707010269165],
    [0.932694971561432, 0.730105042457581],
    [0.557260990142822, 0.572826027870178],
    [0.542901992797852, 0.584792017936707],
    [0.6180260181427, 0.694710969924927],
    [0.607590973377228, 0.694203019142151],
    [0.722943007946014, 0.271963000297546],
    [0.577413976192474, 0.563166975975037],
    [0.614082992076874, 0.281386971473694],
    [0.616907000541687, 0.255886018276215],
    [0.668509006500244, 0.119913995265961],
    [0.770092010498047, 0.232020974159241],
    [0.635536015033722, 0.189248979091644],
    [0.77039098739624, 0.299556016921997],
    [0.826722025871277, 0.278755009174347],
    [0.527121007442474, 0.666198015213013],
    [0.553171992301941, 0.668527007102966],
    [0.577238023281097, 0.673889994621277],
    [0.554691970348358, 0.580065965652466],
    [0.611896991729736, 0.693961024284363],
    [0.59696102142334, 0.706539988517761],
    [0.596370995044708, 0.693953037261963],
    [0.539958000183105, 0.557139039039612],
    [0.568841993808746, 0.692366003990173],
    [0.547818005084991, 0.692366003990173],
    [0.52461302280426, 0.692366003990173],
    [0.534089982509613, 0.779141008853912],
    [0.527670979499817, 0.736225962638855],
    [0.526912987232208, 0.717857003211975],
    [0.526877999305725, 0.704625964164734],
    [0.526966989040375, 0.695277988910675],
    [0.572058022022247, 0.695277988910675],
    [0.573521018028259, 0.703539967536926],
    [0.57683801651001, 0.711845993995667],
    [0.581691026687622, 0.720062971115112],
    [0.609944999217987, 0.639909982681274],
    [0.986046016216278, 0.560034036636353],
    [0.5867999792099, 0.69539999961853],
    [0.590372025966644, 0.701822996139526],
    [0.531915009021759, 0.601536989212036],
    [0.577268004417419, 0.585934996604919],
    [0.536915004253387, 0.593786001205444],
    [0.627542972564697, 0.473352015018463],
    [0.665585994720459, 0.495950996875763],
    [0.588353991508484, 0.546862006187439],
    [0.757824003696442, 0.14767599105835],
    [0.709249973297119, 0.201507985591888],
    [0.672684013843536, 0.256581008434296],
    [0.600408971309662, 0.74900496006012],
    [0.55826598405838, 0.261672019958496],
    [0.570303976535797, 0.187870979309082],
    [0.588165998458862, 0.109044015407562],
    [0.711045026779175, 0.398952007293701],
    [0.781069993972778, 0.435405015945435],
    [0.587247014045715, 0.398931980133057],
    [0.742869973182678, 0.355445981025696],
    [0.572156012058258, 0.437651991844177],
    [0.55186802148819, 0.536570012569427],
    [0.821442008018494, 0.457556009292603],
    [0.752701997756958, 0.457181990146637],
    [0.71375697851181, 0.467626988887787],
    [0.66711300611496, 0.460672974586487],
    [0.631101012229919, 0.447153985500336],
    [0.6008620262146, 0.432473003864288],
    [0.523481011390686, 0.405627012252808],
    [0.810747981071472, 0.523926019668579],
    [0.771045982837677, 0.348959028720856],
    [0.509127020835876, 0.562718033790588],
    [0.595292985439301, 0.485023975372314],
    [0.980530977249146, 0.401564002037048],
    [0.573499977588654, 0.420000016689301],
    [0.602994978427887, 0.548687994480133],
    [0.733529984951019, 0.376977026462555],
    [0.560611009597778, 0.519016981124878],
    [0.967685997486115, 0.644356966018677],
    [0.580985009670258, 0.387160003185272],
    [0.537728011608124, 0.505385041236877],
    [0.760966002941132, 0.779752969741821],
    [0.801778972148895, 0.831938028335571],
    [0.892440974712372, 0.54076099395752],
    [0.816350996494293, 0.740260004997253],
    [0.865594983100891, 0.333687007427216],
    [0.614073991775513, 0.883246004581451],
    [0.508952975273132, 0.579437971115112],
    [0.617941975593567, 0.508316040039062],
    [0.825608015060425, 0.397674977779388],
    [0.681214988231659, 0.39623498916626],
    [0.656635999679565, 0.400596976280212],
    [0.603900015354156, 0.710216999053955],
    [0.81208598613739, 0.588539004325867],
    [0.56801301240921, 0.944564998149872],
    [0.681007981300354, 0.898285031318665],
    [0.733752012252808, 0.869701027870178],
    [0.633830010890961, 0.398822009563446],
    [0.606792986392975, 0.39553701877594],
    [0.589659988880157, 0.391062021255493],
    [0.805015981197357, 0.342108011245728],
    [0.611334979534149, 0.362284004688263],
    [0.634037971496582, 0.355970978736877],
    [0.656635999679565, 0.355356991291046],
    [0.681214988231659, 0.35834002494812],
    [0.698584973812103, 0.363156020641327],
    [0.941866993904114, 0.319076001644135],
    [0.698584973812103, 0.387449026107788],
    [0.584177017211914, 0.624107003211975],
    [0.554318010807037, 0.566076993942261],
    [0.534153997898102, 0.62064003944397],
    [0.711217999458313, 0.819975018501282],
    [0.664629995822906, 0.852871000766754],
    [0.559099972248077, 0.902631998062134],
    [0.871706008911133, 0.791940987110138],
    [0.591234028339386, 0.373893976211548],
    [0.544341027736664, 0.451583981513977],
    [0.624562978744507, 0.924192011356354],
    [0.88577002286911, 0.615028977394104],
    [0.551338016986847, 0.695277988910675],
    [0.551980018615723, 0.704632043838501],
    [0.552887976169586, 0.715808033943176],
    [0.555167973041534, 0.730794012546539],
    [0.569944024085999, 0.767035007476807],
    [0.593203008174896, 0.685675978660583],
    [0.599261999130249, 0.681069016456604],
    [0.607599973678589, 0.677703022956848],
    [0.631937980651855, 0.663500010967255],
    [0.752032995223999, 0.601315021514893],
    [0.547226011753082, 0.420395016670227],
    [0.563543975353241, 0.359827995300293],
    [0.583841025829315, 0.368713974952698],
    [0.586614012718201, 0.692366003990173],
    [0.771915018558502, 0.683578014373779],
    [0.531597018241882, 0.352482974529266],
    [0.588370978832245, 0.804440975189209],
    [0.52079701423645, 0.442565023899078],
    [0.567984998226166, 0.493479013442993],
    [0.543282985687256, 0.819254994392395],
    [0.655317008495331, 0.745514988899231],
    [0.621008992195129, 0.574018001556396],
    [0.625559985637665, 0.78031200170517],
    [0.680198013782501, 0.570719003677368],
    [0.64276397228241, 0.604337990283966],
    [0.704662978649139, 0.621529996395111],
    [0.552012026309967, 0.862591981887817],
    [0.589071989059448, 0.508637011051178],
    [0.685944974422455, 0.775357007980347],
    [0.645735025405884, 0.812640011310577],
    [0.675342977046967, 0.703978002071381],
    [0.810858011245728, 0.646304965019226],
    [0.72012197971344, 0.714666962623596],
    [0.866151988506317, 0.682704985141754],
    [0.663187026977539, 0.644596993923187],
    [0.570082008838654, 0.466325998306274],
    [0.544561982154846, 0.548375964164734],
    [0.562758982181549, 0.558784961700439],
    [0.531987011432648, 0.530140042304993],
    [0.585271000862122, 0.335177004337311],
    [0.622952997684479, 0.32277899980545],
    [0.655896008014679, 0.320163011550903],
    [0.687132000923157, 0.322345972061157],
    [0.716481983661652, 0.333200991153717],
    [0.758756995201111, 0.382786989212036],
    [0.897013008594513, 0.468769013881683],
    [0.732392013072968, 0.424547016620636],
    [0.70211398601532, 0.433162987232208],
    [0.66652500629425, 0.433866024017334],
    [0.633504986763, 0.426087975502014],
    [0.603875994682312, 0.416586995124817],
    [0.579657971858978, 0.409945011138916],
    [0.992439985275269, 0.480777025222778],
    [0.567192018032074, 0.569419980049133],
    [0.54136598110199, 0.478899002075195],
    [0.526564002037048, 0.546118021011353],
    [0.523913025856018, 0.563830018043518],
    [0.531529009342194, 0.555056989192963],
    [0.566035985946655, 0.582329034805298],
    [0.51631098985672, 0.563053965568542],
    [0.5174720287323, 0.577877044677734],
    [0.573594987392426, 0.389806985855103],
    [0.560697972774506, 0.395331978797913],
    [0.549755990505219, 0.399751007556915],
    [0.710287988185883, 0.368252992630005],
    [0.723330020904541, 0.363372981548309]
  ];
});

// src/facemesh/triangulation.js
var require_triangulation = __commonJS((exports2) => {
  __export(exports2, {
    default: () => triangulation_default
  });
  var triangulation_default = [
    127,
    34,
    139,
    11,
    0,
    37,
    232,
    231,
    120,
    72,
    37,
    39,
    128,
    121,
    47,
    232,
    121,
    128,
    104,
    69,
    67,
    175,
    171,
    148,
    157,
    154,
    155,
    118,
    50,
    101,
    73,
    39,
    40,
    9,
    151,
    108,
    48,
    115,
    131,
    194,
    204,
    211,
    74,
    40,
    185,
    80,
    42,
    183,
    40,
    92,
    186,
    230,
    229,
    118,
    202,
    212,
    214,
    83,
    18,
    17,
    76,
    61,
    146,
    160,
    29,
    30,
    56,
    157,
    173,
    106,
    204,
    194,
    135,
    214,
    192,
    203,
    165,
    98,
    21,
    71,
    68,
    51,
    45,
    4,
    144,
    24,
    23,
    77,
    146,
    91,
    205,
    50,
    187,
    201,
    200,
    18,
    91,
    106,
    182,
    90,
    91,
    181,
    85,
    84,
    17,
    206,
    203,
    36,
    148,
    171,
    140,
    92,
    40,
    39,
    193,
    189,
    244,
    159,
    158,
    28,
    247,
    246,
    161,
    236,
    3,
    196,
    54,
    68,
    104,
    193,
    168,
    8,
    117,
    228,
    31,
    189,
    193,
    55,
    98,
    97,
    99,
    126,
    47,
    100,
    166,
    79,
    218,
    155,
    154,
    26,
    209,
    49,
    131,
    135,
    136,
    150,
    47,
    126,
    217,
    223,
    52,
    53,
    45,
    51,
    134,
    211,
    170,
    140,
    67,
    69,
    108,
    43,
    106,
    91,
    230,
    119,
    120,
    226,
    130,
    247,
    63,
    53,
    52,
    238,
    20,
    242,
    46,
    70,
    156,
    78,
    62,
    96,
    46,
    53,
    63,
    143,
    34,
    227,
    173,
    155,
    133,
    123,
    117,
    111,
    44,
    125,
    19,
    236,
    134,
    51,
    216,
    206,
    205,
    154,
    153,
    22,
    39,
    37,
    167,
    200,
    201,
    208,
    36,
    142,
    100,
    57,
    212,
    202,
    20,
    60,
    99,
    28,
    158,
    157,
    35,
    226,
    113,
    160,
    159,
    27,
    204,
    202,
    210,
    113,
    225,
    46,
    43,
    202,
    204,
    62,
    76,
    77,
    137,
    123,
    116,
    41,
    38,
    72,
    203,
    129,
    142,
    64,
    98,
    240,
    49,
    102,
    64,
    41,
    73,
    74,
    212,
    216,
    207,
    42,
    74,
    184,
    169,
    170,
    211,
    170,
    149,
    176,
    105,
    66,
    69,
    122,
    6,
    168,
    123,
    147,
    187,
    96,
    77,
    90,
    65,
    55,
    107,
    89,
    90,
    180,
    101,
    100,
    120,
    63,
    105,
    104,
    93,
    137,
    227,
    15,
    86,
    85,
    129,
    102,
    49,
    14,
    87,
    86,
    55,
    8,
    9,
    100,
    47,
    121,
    145,
    23,
    22,
    88,
    89,
    179,
    6,
    122,
    196,
    88,
    95,
    96,
    138,
    172,
    136,
    215,
    58,
    172,
    115,
    48,
    219,
    42,
    80,
    81,
    195,
    3,
    51,
    43,
    146,
    61,
    171,
    175,
    199,
    81,
    82,
    38,
    53,
    46,
    225,
    144,
    163,
    110,
    246,
    33,
    7,
    52,
    65,
    66,
    229,
    228,
    117,
    34,
    127,
    234,
    107,
    108,
    69,
    109,
    108,
    151,
    48,
    64,
    235,
    62,
    78,
    191,
    129,
    209,
    126,
    111,
    35,
    143,
    163,
    161,
    246,
    117,
    123,
    50,
    222,
    65,
    52,
    19,
    125,
    141,
    221,
    55,
    65,
    3,
    195,
    197,
    25,
    7,
    33,
    220,
    237,
    44,
    70,
    71,
    139,
    122,
    193,
    245,
    247,
    130,
    33,
    71,
    21,
    162,
    153,
    158,
    159,
    170,
    169,
    150,
    188,
    174,
    196,
    216,
    186,
    92,
    144,
    160,
    161,
    2,
    97,
    167,
    141,
    125,
    241,
    164,
    167,
    37,
    72,
    38,
    12,
    145,
    159,
    160,
    38,
    82,
    13,
    63,
    68,
    71,
    226,
    35,
    111,
    158,
    153,
    154,
    101,
    50,
    205,
    206,
    92,
    165,
    209,
    198,
    217,
    165,
    167,
    97,
    220,
    115,
    218,
    133,
    112,
    243,
    239,
    238,
    241,
    214,
    135,
    169,
    190,
    173,
    133,
    171,
    208,
    32,
    125,
    44,
    237,
    86,
    87,
    178,
    85,
    86,
    179,
    84,
    85,
    180,
    83,
    84,
    181,
    201,
    83,
    182,
    137,
    93,
    132,
    76,
    62,
    183,
    61,
    76,
    184,
    57,
    61,
    185,
    212,
    57,
    186,
    214,
    207,
    187,
    34,
    143,
    156,
    79,
    239,
    237,
    123,
    137,
    177,
    44,
    1,
    4,
    201,
    194,
    32,
    64,
    102,
    129,
    213,
    215,
    138,
    59,
    166,
    219,
    242,
    99,
    97,
    2,
    94,
    141,
    75,
    59,
    235,
    24,
    110,
    228,
    25,
    130,
    226,
    23,
    24,
    229,
    22,
    23,
    230,
    26,
    22,
    231,
    112,
    26,
    232,
    189,
    190,
    243,
    221,
    56,
    190,
    28,
    56,
    221,
    27,
    28,
    222,
    29,
    27,
    223,
    30,
    29,
    224,
    247,
    30,
    225,
    238,
    79,
    20,
    166,
    59,
    75,
    60,
    75,
    240,
    147,
    177,
    215,
    20,
    79,
    166,
    187,
    147,
    213,
    112,
    233,
    244,
    233,
    128,
    245,
    128,
    114,
    188,
    114,
    217,
    174,
    131,
    115,
    220,
    217,
    198,
    236,
    198,
    131,
    134,
    177,
    132,
    58,
    143,
    35,
    124,
    110,
    163,
    7,
    228,
    110,
    25,
    356,
    389,
    368,
    11,
    302,
    267,
    452,
    350,
    349,
    302,
    303,
    269,
    357,
    343,
    277,
    452,
    453,
    357,
    333,
    332,
    297,
    175,
    152,
    377,
    384,
    398,
    382,
    347,
    348,
    330,
    303,
    304,
    270,
    9,
    336,
    337,
    278,
    279,
    360,
    418,
    262,
    431,
    304,
    408,
    409,
    310,
    415,
    407,
    270,
    409,
    410,
    450,
    348,
    347,
    422,
    430,
    434,
    313,
    314,
    17,
    306,
    307,
    375,
    387,
    388,
    260,
    286,
    414,
    398,
    335,
    406,
    418,
    364,
    367,
    416,
    423,
    358,
    327,
    251,
    284,
    298,
    281,
    5,
    4,
    373,
    374,
    253,
    307,
    320,
    321,
    425,
    427,
    411,
    421,
    313,
    18,
    321,
    405,
    406,
    320,
    404,
    405,
    315,
    16,
    17,
    426,
    425,
    266,
    377,
    400,
    369,
    322,
    391,
    269,
    417,
    465,
    464,
    386,
    257,
    258,
    466,
    260,
    388,
    456,
    399,
    419,
    284,
    332,
    333,
    417,
    285,
    8,
    346,
    340,
    261,
    413,
    441,
    285,
    327,
    460,
    328,
    355,
    371,
    329,
    392,
    439,
    438,
    382,
    341,
    256,
    429,
    420,
    360,
    364,
    394,
    379,
    277,
    343,
    437,
    443,
    444,
    283,
    275,
    440,
    363,
    431,
    262,
    369,
    297,
    338,
    337,
    273,
    375,
    321,
    450,
    451,
    349,
    446,
    342,
    467,
    293,
    334,
    282,
    458,
    461,
    462,
    276,
    353,
    383,
    308,
    324,
    325,
    276,
    300,
    293,
    372,
    345,
    447,
    382,
    398,
    362,
    352,
    345,
    340,
    274,
    1,
    19,
    456,
    248,
    281,
    436,
    427,
    425,
    381,
    256,
    252,
    269,
    391,
    393,
    200,
    199,
    428,
    266,
    330,
    329,
    287,
    273,
    422,
    250,
    462,
    328,
    258,
    286,
    384,
    265,
    353,
    342,
    387,
    259,
    257,
    424,
    431,
    430,
    342,
    353,
    276,
    273,
    335,
    424,
    292,
    325,
    307,
    366,
    447,
    345,
    271,
    303,
    302,
    423,
    266,
    371,
    294,
    455,
    460,
    279,
    278,
    294,
    271,
    272,
    304,
    432,
    434,
    427,
    272,
    407,
    408,
    394,
    430,
    431,
    395,
    369,
    400,
    334,
    333,
    299,
    351,
    417,
    168,
    352,
    280,
    411,
    325,
    319,
    320,
    295,
    296,
    336,
    319,
    403,
    404,
    330,
    348,
    349,
    293,
    298,
    333,
    323,
    454,
    447,
    15,
    16,
    315,
    358,
    429,
    279,
    14,
    15,
    316,
    285,
    336,
    9,
    329,
    349,
    350,
    374,
    380,
    252,
    318,
    402,
    403,
    6,
    197,
    419,
    318,
    319,
    325,
    367,
    364,
    365,
    435,
    367,
    397,
    344,
    438,
    439,
    272,
    271,
    311,
    195,
    5,
    281,
    273,
    287,
    291,
    396,
    428,
    199,
    311,
    271,
    268,
    283,
    444,
    445,
    373,
    254,
    339,
    263,
    466,
    249,
    282,
    334,
    296,
    449,
    347,
    346,
    264,
    447,
    454,
    336,
    296,
    299,
    338,
    10,
    151,
    278,
    439,
    455,
    292,
    407,
    415,
    358,
    371,
    355,
    340,
    345,
    372,
    390,
    249,
    466,
    346,
    347,
    280,
    442,
    443,
    282,
    19,
    94,
    370,
    441,
    442,
    295,
    248,
    419,
    197,
    263,
    255,
    359,
    440,
    275,
    274,
    300,
    383,
    368,
    351,
    412,
    465,
    263,
    467,
    466,
    301,
    368,
    389,
    380,
    374,
    386,
    395,
    378,
    379,
    412,
    351,
    419,
    436,
    426,
    322,
    373,
    390,
    388,
    2,
    164,
    393,
    370,
    462,
    461,
    164,
    0,
    267,
    302,
    11,
    12,
    374,
    373,
    387,
    268,
    12,
    13,
    293,
    300,
    301,
    446,
    261,
    340,
    385,
    384,
    381,
    330,
    266,
    425,
    426,
    423,
    391,
    429,
    355,
    437,
    391,
    327,
    326,
    440,
    457,
    438,
    341,
    382,
    362,
    459,
    457,
    461,
    434,
    430,
    394,
    414,
    463,
    362,
    396,
    369,
    262,
    354,
    461,
    457,
    316,
    403,
    402,
    315,
    404,
    403,
    314,
    405,
    404,
    313,
    406,
    405,
    421,
    418,
    406,
    366,
    401,
    361,
    306,
    408,
    407,
    291,
    409,
    408,
    287,
    410,
    409,
    432,
    436,
    410,
    434,
    416,
    411,
    264,
    368,
    383,
    309,
    438,
    457,
    352,
    376,
    401,
    274,
    275,
    4,
    421,
    428,
    262,
    294,
    327,
    358,
    433,
    416,
    367,
    289,
    455,
    439,
    462,
    370,
    326,
    2,
    326,
    370,
    305,
    460,
    455,
    254,
    449,
    448,
    255,
    261,
    446,
    253,
    450,
    449,
    252,
    451,
    450,
    256,
    452,
    451,
    341,
    453,
    452,
    413,
    464,
    463,
    441,
    413,
    414,
    258,
    442,
    441,
    257,
    443,
    442,
    259,
    444,
    443,
    260,
    445,
    444,
    467,
    342,
    445,
    459,
    458,
    250,
    289,
    392,
    290,
    290,
    328,
    460,
    376,
    433,
    435,
    250,
    290,
    392,
    411,
    416,
    433,
    341,
    463,
    464,
    453,
    464,
    465,
    357,
    465,
    412,
    343,
    412,
    399,
    360,
    363,
    440,
    437,
    399,
    456,
    420,
    456,
    363,
    401,
    435,
    288,
    372,
    383,
    353,
    339,
    255,
    249,
    448,
    261,
    255,
    133,
    243,
    190,
    133,
    155,
    112,
    33,
    246,
    247,
    33,
    130,
    25,
    398,
    384,
    286,
    362,
    398,
    414,
    362,
    463,
    341,
    263,
    359,
    467,
    263,
    249,
    255,
    466,
    467,
    260,
    75,
    60,
    166,
    238,
    239,
    79,
    162,
    127,
    139,
    72,
    11,
    37,
    121,
    232,
    120,
    73,
    72,
    39,
    114,
    128,
    47,
    233,
    232,
    128,
    103,
    104,
    67,
    152,
    175,
    148,
    173,
    157,
    155,
    119,
    118,
    101,
    74,
    73,
    40,
    107,
    9,
    108,
    49,
    48,
    131,
    32,
    194,
    211,
    184,
    74,
    185,
    191,
    80,
    183,
    185,
    40,
    186,
    119,
    230,
    118,
    210,
    202,
    214,
    84,
    83,
    17,
    77,
    76,
    146,
    161,
    160,
    30,
    190,
    56,
    173,
    182,
    106,
    194,
    138,
    135,
    192,
    129,
    203,
    98,
    54,
    21,
    68,
    5,
    51,
    4,
    145,
    144,
    23,
    90,
    77,
    91,
    207,
    205,
    187,
    83,
    201,
    18,
    181,
    91,
    182,
    180,
    90,
    181,
    16,
    85,
    17,
    205,
    206,
    36,
    176,
    148,
    140,
    165,
    92,
    39,
    245,
    193,
    244,
    27,
    159,
    28,
    30,
    247,
    161,
    174,
    236,
    196,
    103,
    54,
    104,
    55,
    193,
    8,
    111,
    117,
    31,
    221,
    189,
    55,
    240,
    98,
    99,
    142,
    126,
    100,
    219,
    166,
    218,
    112,
    155,
    26,
    198,
    209,
    131,
    169,
    135,
    150,
    114,
    47,
    217,
    224,
    223,
    53,
    220,
    45,
    134,
    32,
    211,
    140,
    109,
    67,
    108,
    146,
    43,
    91,
    231,
    230,
    120,
    113,
    226,
    247,
    105,
    63,
    52,
    241,
    238,
    242,
    124,
    46,
    156,
    95,
    78,
    96,
    70,
    46,
    63,
    116,
    143,
    227,
    116,
    123,
    111,
    1,
    44,
    19,
    3,
    236,
    51,
    207,
    216,
    205,
    26,
    154,
    22,
    165,
    39,
    167,
    199,
    200,
    208,
    101,
    36,
    100,
    43,
    57,
    202,
    242,
    20,
    99,
    56,
    28,
    157,
    124,
    35,
    113,
    29,
    160,
    27,
    211,
    204,
    210,
    124,
    113,
    46,
    106,
    43,
    204,
    96,
    62,
    77,
    227,
    137,
    116,
    73,
    41,
    72,
    36,
    203,
    142,
    235,
    64,
    240,
    48,
    49,
    64,
    42,
    41,
    74,
    214,
    212,
    207,
    183,
    42,
    184,
    210,
    169,
    211,
    140,
    170,
    176,
    104,
    105,
    69,
    193,
    122,
    168,
    50,
    123,
    187,
    89,
    96,
    90,
    66,
    65,
    107,
    179,
    89,
    180,
    119,
    101,
    120,
    68,
    63,
    104,
    234,
    93,
    227,
    16,
    15,
    85,
    209,
    129,
    49,
    15,
    14,
    86,
    107,
    55,
    9,
    120,
    100,
    121,
    153,
    145,
    22,
    178,
    88,
    179,
    197,
    6,
    196,
    89,
    88,
    96,
    135,
    138,
    136,
    138,
    215,
    172,
    218,
    115,
    219,
    41,
    42,
    81,
    5,
    195,
    51,
    57,
    43,
    61,
    208,
    171,
    199,
    41,
    81,
    38,
    224,
    53,
    225,
    24,
    144,
    110,
    105,
    52,
    66,
    118,
    229,
    117,
    227,
    34,
    234,
    66,
    107,
    69,
    10,
    109,
    151,
    219,
    48,
    235,
    183,
    62,
    191,
    142,
    129,
    126,
    116,
    111,
    143,
    7,
    163,
    246,
    118,
    117,
    50,
    223,
    222,
    52,
    94,
    19,
    141,
    222,
    221,
    65,
    196,
    3,
    197,
    45,
    220,
    44,
    156,
    70,
    139,
    188,
    122,
    245,
    139,
    71,
    162,
    145,
    153,
    159,
    149,
    170,
    150,
    122,
    188,
    196,
    206,
    216,
    92,
    163,
    144,
    161,
    164,
    2,
    167,
    242,
    141,
    241,
    0,
    164,
    37,
    11,
    72,
    12,
    144,
    145,
    160,
    12,
    38,
    13,
    70,
    63,
    71,
    31,
    226,
    111,
    157,
    158,
    154,
    36,
    101,
    205,
    203,
    206,
    165,
    126,
    209,
    217,
    98,
    165,
    97,
    237,
    220,
    218,
    237,
    239,
    241,
    210,
    214,
    169,
    140,
    171,
    32,
    241,
    125,
    237,
    179,
    86,
    178,
    180,
    85,
    179,
    181,
    84,
    180,
    182,
    83,
    181,
    194,
    201,
    182,
    177,
    137,
    132,
    184,
    76,
    183,
    185,
    61,
    184,
    186,
    57,
    185,
    216,
    212,
    186,
    192,
    214,
    187,
    139,
    34,
    156,
    218,
    79,
    237,
    147,
    123,
    177,
    45,
    44,
    4,
    208,
    201,
    32,
    98,
    64,
    129,
    192,
    213,
    138,
    235,
    59,
    219,
    141,
    242,
    97,
    97,
    2,
    141,
    240,
    75,
    235,
    229,
    24,
    228,
    31,
    25,
    226,
    230,
    23,
    229,
    231,
    22,
    230,
    232,
    26,
    231,
    233,
    112,
    232,
    244,
    189,
    243,
    189,
    221,
    190,
    222,
    28,
    221,
    223,
    27,
    222,
    224,
    29,
    223,
    225,
    30,
    224,
    113,
    247,
    225,
    99,
    60,
    240,
    213,
    147,
    215,
    60,
    20,
    166,
    192,
    187,
    213,
    243,
    112,
    244,
    244,
    233,
    245,
    245,
    128,
    188,
    188,
    114,
    174,
    134,
    131,
    220,
    174,
    217,
    236,
    236,
    198,
    134,
    215,
    177,
    58,
    156,
    143,
    124,
    25,
    110,
    7,
    31,
    228,
    25,
    264,
    356,
    368,
    0,
    11,
    267,
    451,
    452,
    349,
    267,
    302,
    269,
    350,
    357,
    277,
    350,
    452,
    357,
    299,
    333,
    297,
    396,
    175,
    377,
    381,
    384,
    382,
    280,
    347,
    330,
    269,
    303,
    270,
    151,
    9,
    337,
    344,
    278,
    360,
    424,
    418,
    431,
    270,
    304,
    409,
    272,
    310,
    407,
    322,
    270,
    410,
    449,
    450,
    347,
    432,
    422,
    434,
    18,
    313,
    17,
    291,
    306,
    375,
    259,
    387,
    260,
    424,
    335,
    418,
    434,
    364,
    416,
    391,
    423,
    327,
    301,
    251,
    298,
    275,
    281,
    4,
    254,
    373,
    253,
    375,
    307,
    321,
    280,
    425,
    411,
    200,
    421,
    18,
    335,
    321,
    406,
    321,
    320,
    405,
    314,
    315,
    17,
    423,
    426,
    266,
    396,
    377,
    369,
    270,
    322,
    269,
    413,
    417,
    464,
    385,
    386,
    258,
    248,
    456,
    419,
    298,
    284,
    333,
    168,
    417,
    8,
    448,
    346,
    261,
    417,
    413,
    285,
    326,
    327,
    328,
    277,
    355,
    329,
    309,
    392,
    438,
    381,
    382,
    256,
    279,
    429,
    360,
    365,
    364,
    379,
    355,
    277,
    437,
    282,
    443,
    283,
    281,
    275,
    363,
    395,
    431,
    369,
    299,
    297,
    337,
    335,
    273,
    321,
    348,
    450,
    349,
    359,
    446,
    467,
    283,
    293,
    282,
    250,
    458,
    462,
    300,
    276,
    383,
    292,
    308,
    325,
    283,
    276,
    293,
    264,
    372,
    447,
    346,
    352,
    340,
    354,
    274,
    19,
    363,
    456,
    281,
    426,
    436,
    425,
    380,
    381,
    252,
    267,
    269,
    393,
    421,
    200,
    428,
    371,
    266,
    329,
    432,
    287,
    422,
    290,
    250,
    328,
    385,
    258,
    384,
    446,
    265,
    342,
    386,
    387,
    257,
    422,
    424,
    430,
    445,
    342,
    276,
    422,
    273,
    424,
    306,
    292,
    307,
    352,
    366,
    345,
    268,
    271,
    302,
    358,
    423,
    371,
    327,
    294,
    460,
    331,
    279,
    294,
    303,
    271,
    304,
    436,
    432,
    427,
    304,
    272,
    408,
    395,
    394,
    431,
    378,
    395,
    400,
    296,
    334,
    299,
    6,
    351,
    168,
    376,
    352,
    411,
    307,
    325,
    320,
    285,
    295,
    336,
    320,
    319,
    404,
    329,
    330,
    349,
    334,
    293,
    333,
    366,
    323,
    447,
    316,
    15,
    315,
    331,
    358,
    279,
    317,
    14,
    316,
    8,
    285,
    9,
    277,
    329,
    350,
    253,
    374,
    252,
    319,
    318,
    403,
    351,
    6,
    419,
    324,
    318,
    325,
    397,
    367,
    365,
    288,
    435,
    397,
    278,
    344,
    439,
    310,
    272,
    311,
    248,
    195,
    281,
    375,
    273,
    291,
    175,
    396,
    199,
    312,
    311,
    268,
    276,
    283,
    445,
    390,
    373,
    339,
    295,
    282,
    296,
    448,
    449,
    346,
    356,
    264,
    454,
    337,
    336,
    299,
    337,
    338,
    151,
    294,
    278,
    455,
    308,
    292,
    415,
    429,
    358,
    355,
    265,
    340,
    372,
    388,
    390,
    466,
    352,
    346,
    280,
    295,
    442,
    282,
    354,
    19,
    370,
    285,
    441,
    295,
    195,
    248,
    197,
    457,
    440,
    274,
    301,
    300,
    368,
    417,
    351,
    465,
    251,
    301,
    389,
    385,
    380,
    386,
    394,
    395,
    379,
    399,
    412,
    419,
    410,
    436,
    322,
    387,
    373,
    388,
    326,
    2,
    393,
    354,
    370,
    461,
    393,
    164,
    267,
    268,
    302,
    12,
    386,
    374,
    387,
    312,
    268,
    13,
    298,
    293,
    301,
    265,
    446,
    340,
    380,
    385,
    381,
    280,
    330,
    425,
    322,
    426,
    391,
    420,
    429,
    437,
    393,
    391,
    326,
    344,
    440,
    438,
    458,
    459,
    461,
    364,
    434,
    394,
    428,
    396,
    262,
    274,
    354,
    457,
    317,
    316,
    402,
    316,
    315,
    403,
    315,
    314,
    404,
    314,
    313,
    405,
    313,
    421,
    406,
    323,
    366,
    361,
    292,
    306,
    407,
    306,
    291,
    408,
    291,
    287,
    409,
    287,
    432,
    410,
    427,
    434,
    411,
    372,
    264,
    383,
    459,
    309,
    457,
    366,
    352,
    401,
    1,
    274,
    4,
    418,
    421,
    262,
    331,
    294,
    358,
    435,
    433,
    367,
    392,
    289,
    439,
    328,
    462,
    326,
    94,
    2,
    370,
    289,
    305,
    455,
    339,
    254,
    448,
    359,
    255,
    446,
    254,
    253,
    449,
    253,
    252,
    450,
    252,
    256,
    451,
    256,
    341,
    452,
    414,
    413,
    463,
    286,
    441,
    414,
    286,
    258,
    441,
    258,
    257,
    442,
    257,
    259,
    443,
    259,
    260,
    444,
    260,
    467,
    445,
    309,
    459,
    250,
    305,
    289,
    290,
    305,
    290,
    460,
    401,
    376,
    435,
    309,
    250,
    392,
    376,
    411,
    433,
    453,
    341,
    464,
    357,
    453,
    465,
    343,
    357,
    412,
    437,
    343,
    399,
    344,
    360,
    440,
    420,
    437,
    456,
    360,
    420,
    363,
    361,
    401,
    288,
    265,
    372,
    353,
    390,
    339,
    249,
    339,
    448,
    255
  ];
});

// src/facemesh/facemesh.js
var require_facemesh = __commonJS((exports2) => {
  const tf2 = require("@tensorflow/tfjs");
  const blazeface = require_blazeface();
  const keypoints = require_keypoints();
  const pipe = require_pipeline();
  const uv_coords = require_uvcoords();
  const triangulation = require_triangulation().default;
  class MediaPipeFaceMesh {
    constructor(blazeFace, blazeMeshModel, irisModel, config2) {
      this.pipeline = new pipe.Pipeline(blazeFace, blazeMeshModel, irisModel, config2);
      if (config2)
        this.config = config2;
    }
    async estimateFaces(input, config2) {
      if (config2)
        this.config = config2;
      const image = tf2.tidy(() => {
        if (!(input instanceof tf2.Tensor))
          input = tf2.browser.fromPixels(input);
        return input.toFloat().expandDims(0);
      });
      const predictions = await this.pipeline.predict(image, config2);
      tf2.dispose(image);
      const results = [];
      for (const prediction of predictions || []) {
        const confidence = prediction.confidence.arraySync();
        if (confidence >= this.config.detector.minConfidence) {
          const mesh = prediction.coords ? prediction.coords.arraySync() : null;
          const annotations = {};
          if (mesh && mesh.length > 0) {
            for (const key in keypoints.MESH_ANNOTATIONS) {
              if (this.config.iris.enabled || key.includes("Iris") === false) {
                annotations[key] = keypoints.MESH_ANNOTATIONS[key].map((index) => mesh[index]);
              }
            }
          }
          results.push({
            confidence: confidence || 0,
            box: prediction.box ? [prediction.box.startPoint[0], prediction.box.startPoint[1], prediction.box.endPoint[0] - prediction.box.startPoint[0], prediction.box.endPoint[1] - prediction.box.startPoint[1]] : 0,
            mesh,
            annotations,
            image: prediction.image ? tf2.clone(prediction.image) : null
          });
        }
        prediction.confidence.dispose();
        prediction.image.dispose();
      }
      return results;
    }
  }
  async function load(config2) {
    const models2 = await Promise.all([
      blazeface.load(config2),
      tf2.loadGraphModel(config2.mesh.modelPath, {fromTFHub: config2.mesh.modelPath.includes("tfhub.dev")}),
      tf2.loadGraphModel(config2.iris.modelPath, {fromTFHub: config2.iris.modelPath.includes("tfhub.dev")})
    ]);
    const faceMesh = new MediaPipeFaceMesh(models2[0], models2[1], models2[2], config2);
    return faceMesh;
  }
  exports2.load = load;
  exports2.MediaPipeFaceMesh = MediaPipeFaceMesh;
  exports2.uv_coords = uv_coords;
  exports2.triangulation = triangulation;
});

// src/ssrnet/ssrnet.js
var require_ssrnet = __commonJS((exports2) => {
  const tf2 = require("@tensorflow/tfjs");
  const models2 = {};
  let last = {age: 0, gender: ""};
  let frame = 0;
  async function getImage(image, size) {
    const buffer = tf2.browser.fromPixels(image);
    const resize = tf2.image.resizeBilinear(buffer, [size, size]);
    const expand = tf2.cast(tf2.expandDims(resize, 0), "float32");
    return expand;
  }
  async function loadAge(config2) {
    if (!models2.age)
      models2.age = await tf2.loadGraphModel(config2.face.age.modelPath);
    return models2.age;
  }
  async function loadGender(config2) {
    if (!models2.gender)
      models2.gender = await tf2.loadGraphModel(config2.face.gender.modelPath);
    return models2.gender;
  }
  async function predict(image, config2) {
    if (frame > config2.face.age.skipFrames) {
      frame = 0;
    } else {
      frame += 1;
    }
    if (frame === 0)
      return last;
    let enhance;
    if (image instanceof tf2.Tensor) {
      const resize = tf2.image.resizeBilinear(image, [config2.face.age.inputSize, config2.face.age.inputSize], false);
      enhance = tf2.mul(resize, [255]);
      tf2.dispose(resize);
    } else {
      enhance = await getImage(image, config2.face.age.inputSize);
    }
    const obj = {};
    if (config2.face.age.enabled) {
      const ageT = await models2.age.predict(enhance);
      const data = await ageT.data();
      obj.age = Math.trunc(10 * data[0]) / 10;
      tf2.dispose(ageT);
    }
    if (config2.face.gender.enabled) {
      const genderT = await models2.gender.predict(enhance);
      const data = await genderT.data();
      const confidence = Math.trunc(Math.abs(1.9 * 100 * (data[0] - 0.5))) / 100;
      if (confidence > config2.face.gender.minConfidence) {
        obj.gender = data[0] <= 0.5 ? "female" : "male";
        obj.confidence = confidence;
      }
      tf2.dispose(genderT);
    }
    tf2.dispose(enhance);
    last = obj;
    return obj;
  }
  exports2.predict = predict;
  exports2.loadAge = loadAge;
  exports2.loadGender = loadGender;
});

// src/emotion/emotion.js
var require_emotion = __commonJS((exports2) => {
  const tf2 = require("@tensorflow/tfjs");
  const annotations = ["angry", "discust", "fear", "happy", "sad", "surpise", "neutral"];
  const models2 = {};
  let last = [];
  let frame = 0;
  const multiplier = 1.5;
  function getImage(image, size) {
    const tensor = tf2.tidy(() => {
      const buffer = tf2.browser.fromPixels(image, 1);
      const resize = tf2.image.resizeBilinear(buffer, [size, size]);
      const expand = tf2.cast(tf2.expandDims(resize, 0), "float32");
      return expand;
    });
    return tensor;
  }
  async function load(config2) {
    if (!models2.emotion)
      models2.emotion = await tf2.loadGraphModel(config2.face.emotion.modelPath);
    return models2.emotion;
  }
  async function predict(image, config2) {
    frame += 1;
    if (frame >= config2.face.emotion.skipFrames) {
      frame = 0;
      return last;
    }
    const enhance = tf2.tidy(() => {
      if (image instanceof tf2.Tensor) {
        const resize = tf2.image.resizeBilinear(image, [config2.face.emotion.inputSize, config2.face.emotion.inputSize], false);
        const [r, g, b] = tf2.split(resize, 3, 3);
        if (config2.face.emotion.useGrayscale) {
          const r1 = tf2.mul(r, [0.2989]);
          const g1 = tf2.mul(g, [0.587]);
          const b1 = tf2.mul(b, [0.114]);
          const grayscale = tf2.addN([r1, g1, b1]);
          return grayscale;
        }
        return g;
      }
      return getImage(image, config2.face.emotion.inputSize);
    });
    const obj = [];
    if (config2.face.emotion.enabled) {
      const emotionT = await models2.emotion.predict(enhance);
      const data = await emotionT.data();
      for (let i = 0; i < data.length; i++) {
        if (multiplier * data[i] > config2.face.emotion.minConfidence)
          obj.push({score: Math.min(0.99, Math.trunc(100 * multiplier * data[i]) / 100), emotion: annotations[i]});
      }
      obj.sort((a, b) => b.score - a.score);
      tf2.dispose(emotionT);
    }
    tf2.dispose(enhance);
    last = obj;
    return obj;
  }
  exports2.predict = predict;
  exports2.load = load;
});

// src/posenet/modelBase.js
var require_modelBase = __commonJS((exports2) => {
  const tf2 = require("@tensorflow/tfjs");
  class BaseModel {
    constructor(model, outputStride) {
      this.model = model;
      this.outputStride = outputStride;
      const inputShape = this.model.inputs[0].shape;
      tf2.util.assert(inputShape[1] === -1 && inputShape[2] === -1, () => `Input shape [${inputShape[1]}, ${inputShape[2]}] must both be equal to or -1`);
    }
    predict(input) {
      return tf2.tidy(() => {
        const asFloat = this.preprocessInput(input.toFloat());
        const asBatch = asFloat.expandDims(0);
        const results = this.model.predict(asBatch);
        const results3d = results.map((y) => y.squeeze([0]));
        const namedResults = this.nameOutputResults(results3d);
        return {
          heatmapScores: namedResults.heatmap.sigmoid(),
          offsets: namedResults.offsets,
          displacementFwd: namedResults.displacementFwd,
          displacementBwd: namedResults.displacementBwd
        };
      });
    }
    dispose() {
      this.model.dispose();
    }
  }
  exports2.BaseModel = BaseModel;
});

// src/posenet/modelMobileNet.js
var require_modelMobileNet = __commonJS((exports2) => {
  const tf2 = require("@tensorflow/tfjs");
  const modelBase = require_modelBase();
  class MobileNet extends modelBase.BaseModel {
    preprocessInput(input) {
      return tf2.tidy(() => tf2.div(input, 127.5).sub(1));
    }
    nameOutputResults(results) {
      const [offsets, heatmap, displacementFwd, displacementBwd] = results;
      return {offsets, heatmap, displacementFwd, displacementBwd};
    }
  }
  exports2.MobileNet = MobileNet;
});

// src/posenet/heapSort.js
var require_heapSort = __commonJS((exports2) => {
  function half(k) {
    return Math.floor(k / 2);
  }
  class MaxHeap {
    constructor(maxSize, getElementValue) {
      this.priorityQueue = new Array(maxSize);
      this.numberOfElements = -1;
      this.getElementValue = getElementValue;
    }
    enqueue(x) {
      this.priorityQueue[++this.numberOfElements] = x;
      this.swim(this.numberOfElements);
    }
    dequeue() {
      const max = this.priorityQueue[0];
      this.exchange(0, this.numberOfElements--);
      this.sink(0);
      this.priorityQueue[this.numberOfElements + 1] = null;
      return max;
    }
    empty() {
      return this.numberOfElements === -1;
    }
    size() {
      return this.numberOfElements + 1;
    }
    all() {
      return this.priorityQueue.slice(0, this.numberOfElements + 1);
    }
    max() {
      return this.priorityQueue[0];
    }
    swim(k) {
      while (k > 0 && this.less(half(k), k)) {
        this.exchange(k, half(k));
        k = half(k);
      }
    }
    sink(k) {
      while (2 * k <= this.numberOfElements) {
        let j = 2 * k;
        if (j < this.numberOfElements && this.less(j, j + 1))
          j++;
        if (!this.less(k, j))
          break;
        this.exchange(k, j);
        k = j;
      }
    }
    getValueAt(i) {
      return this.getElementValue(this.priorityQueue[i]);
    }
    less(i, j) {
      return this.getValueAt(i) < this.getValueAt(j);
    }
    exchange(i, j) {
      const t = this.priorityQueue[i];
      this.priorityQueue[i] = this.priorityQueue[j];
      this.priorityQueue[j] = t;
    }
  }
  exports2.MaxHeap = MaxHeap;
});

// src/posenet/buildParts.js
var require_buildParts = __commonJS((exports2) => {
  const heapSort = require_heapSort();
  function scoreIsMaximumInLocalWindow(keypointId, score, heatmapY, heatmapX, localMaximumRadius, scores) {
    const [height, width] = scores.shape;
    let localMaximum = true;
    const yStart = Math.max(heatmapY - localMaximumRadius, 0);
    const yEnd = Math.min(heatmapY + localMaximumRadius + 1, height);
    for (let yCurrent = yStart; yCurrent < yEnd; ++yCurrent) {
      const xStart = Math.max(heatmapX - localMaximumRadius, 0);
      const xEnd = Math.min(heatmapX + localMaximumRadius + 1, width);
      for (let xCurrent = xStart; xCurrent < xEnd; ++xCurrent) {
        if (scores.get(yCurrent, xCurrent, keypointId) > score) {
          localMaximum = false;
          break;
        }
      }
      if (!localMaximum) {
        break;
      }
    }
    return localMaximum;
  }
  function buildPartWithScoreQueue(scoreThreshold, localMaximumRadius, scores) {
    const [height, width, numKeypoints] = scores.shape;
    const queue = new heapSort.MaxHeap(height * width * numKeypoints, ({score}) => score);
    for (let heatmapY = 0; heatmapY < height; ++heatmapY) {
      for (let heatmapX = 0; heatmapX < width; ++heatmapX) {
        for (let keypointId = 0; keypointId < numKeypoints; ++keypointId) {
          const score = scores.get(heatmapY, heatmapX, keypointId);
          if (score < scoreThreshold)
            continue;
          if (scoreIsMaximumInLocalWindow(keypointId, score, heatmapY, heatmapX, localMaximumRadius, scores)) {
            queue.enqueue({score, part: {heatmapY, heatmapX, id: keypointId}});
          }
        }
      }
    }
    return queue;
  }
  exports2.buildPartWithScoreQueue = buildPartWithScoreQueue;
});

// src/posenet/keypoints.js
var require_keypoints2 = __commonJS((exports2) => {
  exports2.partNames = [
    "nose",
    "leftEye",
    "rightEye",
    "leftEar",
    "rightEar",
    "leftShoulder",
    "rightShoulder",
    "leftElbow",
    "rightElbow",
    "leftWrist",
    "rightWrist",
    "leftHip",
    "rightHip",
    "leftKnee",
    "rightKnee",
    "leftAnkle",
    "rightAnkle"
  ];
  exports2.NUM_KEYPOINTS = exports2.partNames.length;
  exports2.partIds = exports2.partNames.reduce((result, jointName, i) => {
    result[jointName] = i;
    return result;
  }, {});
  const connectedPartNames = [
    ["leftHip", "leftShoulder"],
    ["leftElbow", "leftShoulder"],
    ["leftElbow", "leftWrist"],
    ["leftHip", "leftKnee"],
    ["leftKnee", "leftAnkle"],
    ["rightHip", "rightShoulder"],
    ["rightElbow", "rightShoulder"],
    ["rightElbow", "rightWrist"],
    ["rightHip", "rightKnee"],
    ["rightKnee", "rightAnkle"],
    ["leftShoulder", "rightShoulder"],
    ["leftHip", "rightHip"]
  ];
  exports2.poseChain = [
    ["nose", "leftEye"],
    ["leftEye", "leftEar"],
    ["nose", "rightEye"],
    ["rightEye", "rightEar"],
    ["nose", "leftShoulder"],
    ["leftShoulder", "leftElbow"],
    ["leftElbow", "leftWrist"],
    ["leftShoulder", "leftHip"],
    ["leftHip", "leftKnee"],
    ["leftKnee", "leftAnkle"],
    ["nose", "rightShoulder"],
    ["rightShoulder", "rightElbow"],
    ["rightElbow", "rightWrist"],
    ["rightShoulder", "rightHip"],
    ["rightHip", "rightKnee"],
    ["rightKnee", "rightAnkle"]
  ];
  exports2.connectedPartIndices = connectedPartNames.map(([jointNameA, jointNameB]) => [exports2.partIds[jointNameA], exports2.partIds[jointNameB]]);
  exports2.partChannels = [
    "left_face",
    "right_face",
    "right_upper_leg_front",
    "right_lower_leg_back",
    "right_upper_leg_back",
    "left_lower_leg_front",
    "left_upper_leg_front",
    "left_upper_leg_back",
    "left_lower_leg_back",
    "right_feet",
    "right_lower_leg_front",
    "left_feet",
    "torso_front",
    "torso_back",
    "right_upper_arm_front",
    "right_upper_arm_back",
    "right_lower_arm_back",
    "left_lower_arm_front",
    "left_upper_arm_front",
    "left_upper_arm_back",
    "left_lower_arm_back",
    "right_hand",
    "right_lower_arm_front",
    "left_hand"
  ];
});

// src/posenet/vectors.js
var require_vectors = __commonJS((exports2) => {
  const kpt = require_keypoints2();
  function getOffsetPoint(y, x, keypoint, offsets) {
    return {
      y: offsets.get(y, x, keypoint),
      x: offsets.get(y, x, keypoint + kpt.NUM_KEYPOINTS)
    };
  }
  exports2.getOffsetPoint = getOffsetPoint;
  function getImageCoords(part, outputStride, offsets) {
    const {heatmapY, heatmapX, id: keypoint} = part;
    const {y, x} = getOffsetPoint(heatmapY, heatmapX, keypoint, offsets);
    return {
      x: part.heatmapX * outputStride + x,
      y: part.heatmapY * outputStride + y
    };
  }
  exports2.getImageCoords = getImageCoords;
  function fillArray(element, size) {
    const result = new Array(size);
    for (let i = 0; i < size; i++) {
      result[i] = element;
    }
    return result;
  }
  exports2.fillArray = fillArray;
  function clamp(a, min, max) {
    if (a < min)
      return min;
    if (a > max)
      return max;
    return a;
  }
  exports2.clamp = clamp;
  function squaredDistance(y1, x1, y2, x2) {
    const dy = y2 - y1;
    const dx = x2 - x1;
    return dy * dy + dx * dx;
  }
  exports2.squaredDistance = squaredDistance;
  function addVectors(a, b) {
    return {x: a.x + b.x, y: a.y + b.y};
  }
  exports2.addVectors = addVectors;
  function clampVector(a, min, max) {
    return {y: clamp(a.y, min, max), x: clamp(a.x, min, max)};
  }
  exports2.clampVector = clampVector;
});

// src/posenet/decodePose.js
var require_decodePose = __commonJS((exports2) => {
  const keypoints = require_keypoints2();
  const vectors = require_vectors();
  const parentChildrenTuples = keypoints.poseChain.map(([parentJoinName, childJoinName]) => [keypoints.partIds[parentJoinName], keypoints.partIds[childJoinName]]);
  const parentToChildEdges = parentChildrenTuples.map(([, childJointId]) => childJointId);
  const childToParentEdges = parentChildrenTuples.map(([parentJointId]) => parentJointId);
  function getDisplacement(edgeId, point, displacements) {
    const numEdges = displacements.shape[2] / 2;
    return {
      y: displacements.get(point.y, point.x, edgeId),
      x: displacements.get(point.y, point.x, numEdges + edgeId)
    };
  }
  function getStridedIndexNearPoint(point, outputStride, height, width) {
    return {
      y: vectors.clamp(Math.round(point.y / outputStride), 0, height - 1),
      x: vectors.clamp(Math.round(point.x / outputStride), 0, width - 1)
    };
  }
  function traverseToTargetKeypoint(edgeId, sourceKeypoint, targetKeypointId, scoresBuffer, offsets, outputStride, displacements, offsetRefineStep = 2) {
    const [height, width] = scoresBuffer.shape;
    const sourceKeypointIndices = getStridedIndexNearPoint(sourceKeypoint.position, outputStride, height, width);
    const displacement = getDisplacement(edgeId, sourceKeypointIndices, displacements);
    const displacedPoint = vectors.addVectors(sourceKeypoint.position, displacement);
    let targetKeypoint = displacedPoint;
    for (let i = 0; i < offsetRefineStep; i++) {
      const targetKeypointIndices = getStridedIndexNearPoint(targetKeypoint, outputStride, height, width);
      const offsetPoint = vectors.getOffsetPoint(targetKeypointIndices.y, targetKeypointIndices.x, targetKeypointId, offsets);
      targetKeypoint = vectors.addVectors({
        x: targetKeypointIndices.x * outputStride,
        y: targetKeypointIndices.y * outputStride
      }, {x: offsetPoint.x, y: offsetPoint.y});
    }
    const targetKeyPointIndices = getStridedIndexNearPoint(targetKeypoint, outputStride, height, width);
    const score = scoresBuffer.get(targetKeyPointIndices.y, targetKeyPointIndices.x, targetKeypointId);
    return {position: targetKeypoint, part: keypoints.partNames[targetKeypointId], score};
  }
  function decodePose(root, scores, offsets, outputStride, displacementsFwd, displacementsBwd) {
    const numParts = scores.shape[2];
    const numEdges = parentToChildEdges.length;
    const instanceKeypoints = new Array(numParts);
    const {part: rootPart, score: rootScore} = root;
    const rootPoint = vectors.getImageCoords(rootPart, outputStride, offsets);
    instanceKeypoints[rootPart.id] = {
      score: rootScore,
      part: keypoints.partNames[rootPart.id],
      position: rootPoint
    };
    for (let edge = numEdges - 1; edge >= 0; --edge) {
      const sourceKeypointId = parentToChildEdges[edge];
      const targetKeypointId = childToParentEdges[edge];
      if (instanceKeypoints[sourceKeypointId] && !instanceKeypoints[targetKeypointId]) {
        instanceKeypoints[targetKeypointId] = traverseToTargetKeypoint(edge, instanceKeypoints[sourceKeypointId], targetKeypointId, scores, offsets, outputStride, displacementsBwd);
      }
    }
    for (let edge = 0; edge < numEdges; ++edge) {
      const sourceKeypointId = childToParentEdges[edge];
      const targetKeypointId = parentToChildEdges[edge];
      if (instanceKeypoints[sourceKeypointId] && !instanceKeypoints[targetKeypointId]) {
        instanceKeypoints[targetKeypointId] = traverseToTargetKeypoint(edge, instanceKeypoints[sourceKeypointId], targetKeypointId, scores, offsets, outputStride, displacementsFwd);
      }
    }
    return instanceKeypoints;
  }
  exports2.decodePose = decodePose;
});

// src/posenet/decodeMultiple.js
var require_decodeMultiple = __commonJS((exports2) => {
  const buildParts = require_buildParts();
  const decodePose = require_decodePose();
  const vectors = require_vectors();
  function withinNmsRadiusOfCorrespondingPoint(poses, squaredNmsRadius, {x, y}, keypointId) {
    return poses.some(({keypoints}) => {
      const correspondingKeypoint = keypoints[keypointId].position;
      return vectors.squaredDistance(y, x, correspondingKeypoint.y, correspondingKeypoint.x) <= squaredNmsRadius;
    });
  }
  function getInstanceScore(existingPoses, squaredNmsRadius, instanceKeypoints) {
    const notOverlappedKeypointScores = instanceKeypoints.reduce((result, {position, score}, keypointId) => {
      if (!withinNmsRadiusOfCorrespondingPoint(existingPoses, squaredNmsRadius, position, keypointId)) {
        result += score;
      }
      return result;
    }, 0);
    return notOverlappedKeypointScores / instanceKeypoints.length;
  }
  const kLocalMaximumRadius = 1;
  function decodeMultiplePoses(scoresBuffer, offsetsBuffer, displacementsFwdBuffer, displacementsBwdBuffer, outputStride, maxPoseDetections, scoreThreshold = 0.5, nmsRadius = 20) {
    const poses = [];
    const queue = buildParts.buildPartWithScoreQueue(scoreThreshold, kLocalMaximumRadius, scoresBuffer);
    const squaredNmsRadius = nmsRadius * nmsRadius;
    while (poses.length < maxPoseDetections && !queue.empty()) {
      const root = queue.dequeue();
      const rootImageCoords = vectors.getImageCoords(root.part, outputStride, offsetsBuffer);
      if (withinNmsRadiusOfCorrespondingPoint(poses, squaredNmsRadius, rootImageCoords, root.part.id))
        continue;
      const keypoints = decodePose.decodePose(root, scoresBuffer, offsetsBuffer, outputStride, displacementsFwdBuffer, displacementsBwdBuffer);
      const score = getInstanceScore(poses, squaredNmsRadius, keypoints);
      poses.push({keypoints, score});
    }
    return poses;
  }
  exports2.decodeMultiplePoses = decodeMultiplePoses;
});

// src/posenet/util.js
var require_util2 = __commonJS((exports2) => {
  const tf2 = require("@tensorflow/tfjs");
  const kpt = require_keypoints2();
  function eitherPointDoesntMeetConfidence(a, b, minConfidence) {
    return a < minConfidence || b < minConfidence;
  }
  function getAdjacentKeyPoints(keypoints, minConfidence) {
    return kpt.connectedPartIndices.reduce((result, [leftJoint, rightJoint]) => {
      if (eitherPointDoesntMeetConfidence(keypoints[leftJoint].score, keypoints[rightJoint].score, minConfidence)) {
        return result;
      }
      result.push([keypoints[leftJoint], keypoints[rightJoint]]);
      return result;
    }, []);
  }
  exports2.getAdjacentKeyPoints = getAdjacentKeyPoints;
  const {NEGATIVE_INFINITY, POSITIVE_INFINITY} = Number;
  function getBoundingBox(keypoints) {
    return keypoints.reduce(({maxX, maxY, minX, minY}, {position: {x, y}}) => ({
      maxX: Math.max(maxX, x),
      maxY: Math.max(maxY, y),
      minX: Math.min(minX, x),
      minY: Math.min(minY, y)
    }), {
      maxX: NEGATIVE_INFINITY,
      maxY: NEGATIVE_INFINITY,
      minX: POSITIVE_INFINITY,
      minY: POSITIVE_INFINITY
    });
  }
  exports2.getBoundingBox = getBoundingBox;
  function getBoundingBoxPoints(keypoints) {
    const {minX, minY, maxX, maxY} = getBoundingBox(keypoints);
    return [{x: minX, y: minY}, {x: maxX, y: minY}, {x: maxX, y: maxY}, {x: minX, y: maxY}];
  }
  exports2.getBoundingBoxPoints = getBoundingBoxPoints;
  async function toTensorBuffers3D(tensors) {
    return Promise.all(tensors.map((tensor) => tensor.buffer()));
  }
  exports2.toTensorBuffers3D = toTensorBuffers3D;
  function scalePose(pose, scaleY, scaleX, offsetY = 0, offsetX = 0) {
    return {
      score: pose.score,
      keypoints: pose.keypoints.map(({score, part, position}) => ({
        score,
        part,
        position: {
          x: position.x * scaleX + offsetX,
          y: position.y * scaleY + offsetY
        }
      }))
    };
  }
  exports2.scalePose = scalePose;
  function scalePoses(poses, scaleY, scaleX, offsetY = 0, offsetX = 0) {
    if (scaleX === 1 && scaleY === 1 && offsetY === 0 && offsetX === 0) {
      return poses;
    }
    return poses.map((pose) => scalePose(pose, scaleY, scaleX, offsetY, offsetX));
  }
  exports2.scalePoses = scalePoses;
  function getInputTensorDimensions(input) {
    return input instanceof tf2.Tensor ? [input.shape[0], input.shape[1]] : [input.height, input.width];
  }
  exports2.getInputTensorDimensions = getInputTensorDimensions;
  function toInputTensor(input) {
    return input instanceof tf2.Tensor ? input : tf2.browser.fromPixels(input);
  }
  exports2.toInputTensor = toInputTensor;
  function toResizedInputTensor(input, resizeHeight, resizeWidth) {
    return tf2.tidy(() => {
      const imageTensor = toInputTensor(input);
      return imageTensor.resizeBilinear([resizeHeight, resizeWidth]);
    });
  }
  exports2.toResizedInputTensor = toResizedInputTensor;
  function padAndResizeTo(input, [targetH, targetW]) {
    const [height, width] = getInputTensorDimensions(input);
    const targetAspect = targetW / targetH;
    const aspect = width / height;
    let [padT, padB, padL, padR] = [0, 0, 0, 0];
    if (aspect < targetAspect) {
      padT = 0;
      padB = 0;
      padL = Math.round(0.5 * (targetAspect * height - width));
      padR = Math.round(0.5 * (targetAspect * height - width));
    } else {
      padT = Math.round(0.5 * (1 / targetAspect * width - height));
      padB = Math.round(0.5 * (1 / targetAspect * width - height));
      padL = 0;
      padR = 0;
    }
    const resized = tf2.tidy(() => {
      let imageTensor = toInputTensor(input);
      imageTensor = tf2.pad3d(imageTensor, [[padT, padB], [padL, padR], [0, 0]]);
      return imageTensor.resizeBilinear([targetH, targetW]);
    });
    return {resized, padding: {top: padT, left: padL, right: padR, bottom: padB}};
  }
  exports2.padAndResizeTo = padAndResizeTo;
  function scaleAndFlipPoses(poses, [height, width], [inputResolutionHeight, inputResolutionWidth], padding) {
    const scaleY = (height + padding.top + padding.bottom) / inputResolutionHeight;
    const scaleX = (width + padding.left + padding.right) / inputResolutionWidth;
    const scaledPoses = scalePoses(poses, scaleY, scaleX, -padding.top, -padding.left);
    return scaledPoses;
  }
  exports2.scaleAndFlipPoses = scaleAndFlipPoses;
});

// src/posenet/modelPoseNet.js
var require_modelPoseNet = __commonJS((exports2) => {
  const tf2 = require("@tensorflow/tfjs");
  const modelMobileNet = require_modelMobileNet();
  const decodeMultiple = require_decodeMultiple();
  const util = require_util2();
  class PoseNet {
    constructor(net) {
      this.baseModel = net;
    }
    async estimatePoses(input, config2) {
      const outputStride = config2.outputStride;
      const [height, width] = util.getInputTensorDimensions(input);
      const {resized, padding} = util.padAndResizeTo(input, [config2.inputResolution, config2.inputResolution]);
      const {heatmapScores, offsets, displacementFwd, displacementBwd} = this.baseModel.predict(resized);
      const allTensorBuffers = await util.toTensorBuffers3D([heatmapScores, offsets, displacementFwd, displacementBwd]);
      const scoresBuffer = allTensorBuffers[0];
      const offsetsBuffer = allTensorBuffers[1];
      const displacementsFwdBuffer = allTensorBuffers[2];
      const displacementsBwdBuffer = allTensorBuffers[3];
      const poses = await decodeMultiple.decodeMultiplePoses(scoresBuffer, offsetsBuffer, displacementsFwdBuffer, displacementsBwdBuffer, outputStride, config2.maxDetections, config2.scoreThreshold, config2.nmsRadius);
      const resultPoses = util.scaleAndFlipPoses(poses, [height, width], [config2.inputResolution, config2.inputResolution], padding);
      heatmapScores.dispose();
      offsets.dispose();
      displacementFwd.dispose();
      displacementBwd.dispose();
      resized.dispose();
      return resultPoses;
    }
    dispose() {
      this.baseModel.dispose();
    }
  }
  exports2.PoseNet = PoseNet;
  async function loadMobileNet(config2) {
    const graphModel = await tf2.loadGraphModel(config2.modelPath);
    const mobilenet = new modelMobileNet.MobileNet(graphModel, config2.outputStride);
    return new PoseNet(mobilenet);
  }
  async function load(config2) {
    return loadMobileNet(config2);
  }
  exports2.load = load;
});

// src/posenet/posenet.js
var require_posenet = __commonJS((exports2) => {
  const modelMobileNet = require_modelMobileNet();
  const modelPoseNet = require_modelPoseNet();
  const decodeMultiple = require_decodeMultiple();
  const keypoints = require_keypoints2();
  const util = require_util2();
  exports2.load = modelPoseNet.load;
  exports2.PoseNet = modelPoseNet.PoseNet;
  exports2.MobileNet = modelMobileNet.MobileNet;
  exports2.decodeMultiplePoses = decodeMultiple.decodeMultiplePoses;
  exports2.partChannels = keypoints.partChannels;
  exports2.partIds = keypoints.partIds;
  exports2.partNames = keypoints.partNames;
  exports2.poseChain = keypoints.poseChain;
  exports2.getAdjacentKeyPoints = util.getAdjacentKeyPoints;
  exports2.getBoundingBox = util.getBoundingBox;
  exports2.getBoundingBoxPoints = util.getBoundingBoxPoints;
  exports2.scaleAndFlipPoses = util.scaleAndFlipPoses;
  exports2.scalePose = util.scalePose;
});

// src/handpose/box.js
var require_box2 = __commonJS((exports2) => {
  const tf2 = require("@tensorflow/tfjs");
  function getBoxSize(box) {
    return [
      Math.abs(box.endPoint[0] - box.startPoint[0]),
      Math.abs(box.endPoint[1] - box.startPoint[1])
    ];
  }
  exports2.getBoxSize = getBoxSize;
  function getBoxCenter(box) {
    return [
      box.startPoint[0] + (box.endPoint[0] - box.startPoint[0]) / 2,
      box.startPoint[1] + (box.endPoint[1] - box.startPoint[1]) / 2
    ];
  }
  exports2.getBoxCenter = getBoxCenter;
  function cutBoxFromImageAndResize(box, image, cropSize) {
    const h = image.shape[1];
    const w = image.shape[2];
    const boxes = [[
      box.startPoint[1] / h,
      box.startPoint[0] / w,
      box.endPoint[1] / h,
      box.endPoint[0] / w
    ]];
    return tf2.image.cropAndResize(image, boxes, [0], cropSize);
  }
  exports2.cutBoxFromImageAndResize = cutBoxFromImageAndResize;
  function scaleBoxCoordinates(box, factor) {
    const startPoint = [box.startPoint[0] * factor[0], box.startPoint[1] * factor[1]];
    const endPoint = [box.endPoint[0] * factor[0], box.endPoint[1] * factor[1]];
    const palmLandmarks = box.palmLandmarks.map((coord) => {
      const scaledCoord = [coord[0] * factor[0], coord[1] * factor[1]];
      return scaledCoord;
    });
    return {startPoint, endPoint, palmLandmarks};
  }
  exports2.scaleBoxCoordinates = scaleBoxCoordinates;
  function enlargeBox(box, factor = 1.5) {
    const center = getBoxCenter(box);
    const size = getBoxSize(box);
    const newHalfSize = [factor * size[0] / 2, factor * size[1] / 2];
    const startPoint = [center[0] - newHalfSize[0], center[1] - newHalfSize[1]];
    const endPoint = [center[0] + newHalfSize[0], center[1] + newHalfSize[1]];
    return {startPoint, endPoint, palmLandmarks: box.palmLandmarks};
  }
  exports2.enlargeBox = enlargeBox;
  function squarifyBox(box) {
    const centers = getBoxCenter(box);
    const size = getBoxSize(box);
    const maxEdge = Math.max(...size);
    const halfSize = maxEdge / 2;
    const startPoint = [centers[0] - halfSize, centers[1] - halfSize];
    const endPoint = [centers[0] + halfSize, centers[1] + halfSize];
    return {startPoint, endPoint, palmLandmarks: box.palmLandmarks};
  }
  exports2.squarifyBox = squarifyBox;
  function shiftBox(box, shiftFactor) {
    const boxSize = [
      box.endPoint[0] - box.startPoint[0],
      box.endPoint[1] - box.startPoint[1]
    ];
    const shiftVector = [boxSize[0] * shiftFactor[0], boxSize[1] * shiftFactor[1]];
    const startPoint = [box.startPoint[0] + shiftVector[0], box.startPoint[1] + shiftVector[1]];
    const endPoint = [box.endPoint[0] + shiftVector[0], box.endPoint[1] + shiftVector[1]];
    return {startPoint, endPoint, palmLandmarks: box.palmLandmarks};
  }
  exports2.shiftBox = shiftBox;
});

// src/handpose/handdetector.js
var require_handdetector = __commonJS((exports2) => {
  const tf2 = require("@tensorflow/tfjs");
  const bounding = require_box2();
  class HandDetector {
    constructor(model, anchors, config2) {
      this.model = model;
      this.width = config2.inputSize;
      this.height = config2.inputSize;
      this.anchors = anchors.map((anchor) => [anchor.x_center, anchor.y_center]);
      this.anchorsTensor = tf2.tensor2d(this.anchors);
      this.inputSizeTensor = tf2.tensor1d([config2.inputSize, config2.inputSize]);
      this.doubleInputSizeTensor = tf2.tensor1d([config2.inputSize * 2, config2.inputSize * 2]);
    }
    normalizeBoxes(boxes) {
      return tf2.tidy(() => {
        const boxOffsets = tf2.slice(boxes, [0, 0], [-1, 2]);
        const boxSizes = tf2.slice(boxes, [0, 2], [-1, 2]);
        const boxCenterPoints = tf2.add(tf2.div(boxOffsets, this.inputSizeTensor), this.anchorsTensor);
        const halfBoxSizes = tf2.div(boxSizes, this.doubleInputSizeTensor);
        const startPoints = tf2.mul(tf2.sub(boxCenterPoints, halfBoxSizes), this.inputSizeTensor);
        const endPoints = tf2.mul(tf2.add(boxCenterPoints, halfBoxSizes), this.inputSizeTensor);
        return tf2.concat2d([startPoints, endPoints], 1);
      });
    }
    normalizeLandmarks(rawPalmLandmarks, index) {
      return tf2.tidy(() => {
        const landmarks = tf2.add(tf2.div(rawPalmLandmarks.reshape([-1, 7, 2]), this.inputSizeTensor), this.anchors[index]);
        return tf2.mul(landmarks, this.inputSizeTensor);
      });
    }
    async getBoundingBoxes(input) {
      const normalizedInput = tf2.tidy(() => tf2.mul(tf2.sub(input, 0.5), 2));
      const batchedPrediction = this.model.predict(normalizedInput);
      const prediction = batchedPrediction.squeeze();
      const scores = tf2.tidy(() => tf2.sigmoid(tf2.slice(prediction, [0, 0], [-1, 1])).squeeze());
      const rawBoxes = tf2.slice(prediction, [0, 1], [-1, 4]);
      const boxes = this.normalizeBoxes(rawBoxes);
      const boxesWithHandsTensor = await tf2.image.nonMaxSuppressionAsync(boxes, scores, this.maxHands, this.iouThreshold, this.scoreThreshold);
      const boxesWithHands = await boxesWithHandsTensor.array();
      const toDispose = [
        normalizedInput,
        batchedPrediction,
        boxesWithHandsTensor,
        prediction,
        boxes,
        rawBoxes,
        scores
      ];
      if (boxesWithHands.length === 0) {
        toDispose.forEach((tensor) => tensor.dispose());
        return null;
      }
      const detectedHands = tf2.tidy(() => {
        const detectedBoxes = [];
        for (const i in boxesWithHands) {
          const boxIndex = boxesWithHands[i];
          const matchingBox = tf2.slice(boxes, [boxIndex, 0], [1, -1]);
          const rawPalmLandmarks = tf2.slice(prediction, [boxIndex, 5], [1, 14]);
          const palmLandmarks = tf2.tidy(() => this.normalizeLandmarks(rawPalmLandmarks, boxIndex).reshape([-1, 2]));
          detectedBoxes.push({boxes: matchingBox, palmLandmarks});
        }
        return detectedBoxes;
      });
      return detectedHands;
    }
    async estimateHandBounds(input, config2) {
      const inputHeight = input.shape[1];
      const inputWidth = input.shape[2];
      this.iouThreshold = config2.iouThreshold;
      this.scoreThreshold = config2.scoreThreshold;
      this.maxHands = config2.maxHands;
      const image = tf2.tidy(() => input.resizeBilinear([this.width, this.height]).div(255));
      const predictions = await this.getBoundingBoxes(image);
      image.dispose();
      if (!predictions || predictions.length === 0)
        return null;
      const hands = [];
      for (const i in predictions) {
        const prediction = predictions[i];
        const boundingBoxes = await prediction.boxes.array();
        const startPoint = boundingBoxes[0].slice(0, 2);
        const endPoint = boundingBoxes[0].slice(2, 4);
        const palmLandmarks = await prediction.palmLandmarks.array();
        prediction.boxes.dispose();
        prediction.palmLandmarks.dispose();
        hands.push(bounding.scaleBoxCoordinates({startPoint, endPoint, palmLandmarks}, [inputWidth / this.width, inputHeight / this.height]));
      }
      return hands;
    }
  }
  exports2.HandDetector = HandDetector;
});

// src/handpose/keypoints.js
var require_keypoints3 = __commonJS((exports2) => {
  exports2.MESH_ANNOTATIONS = {
    thumb: [1, 2, 3, 4],
    indexFinger: [5, 6, 7, 8],
    middleFinger: [9, 10, 11, 12],
    ringFinger: [13, 14, 15, 16],
    pinky: [17, 18, 19, 20],
    palmBase: [0]
  };
});

// src/handpose/util.js
var require_util3 = __commonJS((exports2) => {
  function normalizeRadians(angle) {
    return angle - 2 * Math.PI * Math.floor((angle + Math.PI) / (2 * Math.PI));
  }
  exports2.normalizeRadians = normalizeRadians;
  function computeRotation(point1, point2) {
    const radians = Math.PI / 2 - Math.atan2(-(point2[1] - point1[1]), point2[0] - point1[0]);
    return normalizeRadians(radians);
  }
  exports2.computeRotation = computeRotation;
  const buildTranslationMatrix = (x, y) => [[1, 0, x], [0, 1, y], [0, 0, 1]];
  function dot(v1, v2) {
    let product = 0;
    for (let i = 0; i < v1.length; i++) {
      product += v1[i] * v2[i];
    }
    return product;
  }
  exports2.dot = dot;
  function getColumnFrom2DArr(arr, columnIndex) {
    const column = [];
    for (let i = 0; i < arr.length; i++) {
      column.push(arr[i][columnIndex]);
    }
    return column;
  }
  exports2.getColumnFrom2DArr = getColumnFrom2DArr;
  function multiplyTransformMatrices(mat1, mat2) {
    const product = [];
    const size = mat1.length;
    for (let row = 0; row < size; row++) {
      product.push([]);
      for (let col = 0; col < size; col++) {
        product[row].push(dot(mat1[row], getColumnFrom2DArr(mat2, col)));
      }
    }
    return product;
  }
  function buildRotationMatrix(rotation, center) {
    const cosA = Math.cos(rotation);
    const sinA = Math.sin(rotation);
    const rotationMatrix = [[cosA, -sinA, 0], [sinA, cosA, 0], [0, 0, 1]];
    const translationMatrix = buildTranslationMatrix(center[0], center[1]);
    const translationTimesRotation = multiplyTransformMatrices(translationMatrix, rotationMatrix);
    const negativeTranslationMatrix = buildTranslationMatrix(-center[0], -center[1]);
    return multiplyTransformMatrices(translationTimesRotation, negativeTranslationMatrix);
  }
  exports2.buildRotationMatrix = buildRotationMatrix;
  function invertTransformMatrix(matrix) {
    const rotationComponent = [[matrix[0][0], matrix[1][0]], [matrix[0][1], matrix[1][1]]];
    const translationComponent = [matrix[0][2], matrix[1][2]];
    const invertedTranslation = [
      -dot(rotationComponent[0], translationComponent),
      -dot(rotationComponent[1], translationComponent)
    ];
    return [
      rotationComponent[0].concat(invertedTranslation[0]),
      rotationComponent[1].concat(invertedTranslation[1]),
      [0, 0, 1]
    ];
  }
  exports2.invertTransformMatrix = invertTransformMatrix;
  function rotatePoint(homogeneousCoordinate, rotationMatrix) {
    return [
      dot(homogeneousCoordinate, rotationMatrix[0]),
      dot(homogeneousCoordinate, rotationMatrix[1])
    ];
  }
  exports2.rotatePoint = rotatePoint;
});

// src/handpose/pipeline.js
var require_pipeline2 = __commonJS((exports2) => {
  const tf2 = require("@tensorflow/tfjs");
  const bounding = require_box2();
  const util = require_util3();
  const UPDATE_REGION_OF_INTEREST_IOU_THRESHOLD = 0.8;
  const PALM_BOX_SHIFT_VECTOR = [0, -0.4];
  const HAND_BOX_SHIFT_VECTOR = [0, -0.1];
  const HAND_BOX_ENLARGE_FACTOR = 1.65;
  const PALM_LANDMARK_IDS = [0, 5, 9, 13, 17, 1, 2];
  const PALM_LANDMARKS_INDEX_OF_PALM_BASE = 0;
  const PALM_LANDMARKS_INDEX_OF_MIDDLE_FINGER_BASE = 2;
  class HandPipeline {
    constructor(boundingBoxDetector, meshDetector, config2) {
      this.regionsOfInterest = [];
      this.runsWithoutHandDetector = 0;
      this.boundingBoxDetector = boundingBoxDetector;
      this.meshDetector = meshDetector;
      this.meshWidth = config2.inputSize;
      this.meshHeight = config2.inputSize;
      this.enlargeFactor = config2.enlargeFactor;
    }
    getBoxForPalmLandmarks(palmLandmarks, rotationMatrix) {
      const rotatedPalmLandmarks = palmLandmarks.map((coord) => {
        const homogeneousCoordinate = [...coord, 1];
        return util.rotatePoint(homogeneousCoordinate, rotationMatrix);
      });
      const boxAroundPalm = this.calculateLandmarksBoundingBox(rotatedPalmLandmarks);
      return bounding.enlargeBox(bounding.squarifyBox(bounding.shiftBox(boxAroundPalm, PALM_BOX_SHIFT_VECTOR)), this.enlargeFactor);
    }
    getBoxForHandLandmarks(landmarks) {
      const boundingBox = this.calculateLandmarksBoundingBox(landmarks);
      const boxAroundHand = bounding.enlargeBox(bounding.squarifyBox(bounding.shiftBox(boundingBox, HAND_BOX_SHIFT_VECTOR)), HAND_BOX_ENLARGE_FACTOR);
      const palmLandmarks = [];
      for (let i = 0; i < PALM_LANDMARK_IDS.length; i++) {
        palmLandmarks.push(landmarks[PALM_LANDMARK_IDS[i]].slice(0, 2));
      }
      boxAroundHand.palmLandmarks = palmLandmarks;
      return boxAroundHand;
    }
    transformRawCoords(rawCoords, box, angle, rotationMatrix) {
      const boxSize = bounding.getBoxSize(box);
      const scaleFactor = [boxSize[0] / this.meshWidth, boxSize[1] / this.meshHeight];
      const coordsScaled = rawCoords.map((coord) => [
        scaleFactor[0] * (coord[0] - this.meshWidth / 2),
        scaleFactor[1] * (coord[1] - this.meshHeight / 2),
        coord[2]
      ]);
      const coordsRotationMatrix = util.buildRotationMatrix(angle, [0, 0]);
      const coordsRotated = coordsScaled.map((coord) => {
        const rotated = util.rotatePoint(coord, coordsRotationMatrix);
        return [...rotated, coord[2]];
      });
      const inverseRotationMatrix = util.invertTransformMatrix(rotationMatrix);
      const boxCenter = [...bounding.getBoxCenter(box), 1];
      const originalBoxCenter = [
        util.dot(boxCenter, inverseRotationMatrix[0]),
        util.dot(boxCenter, inverseRotationMatrix[1])
      ];
      return coordsRotated.map((coord) => [
        coord[0] + originalBoxCenter[0],
        coord[1] + originalBoxCenter[1],
        coord[2]
      ]);
    }
    async estimateHands(image, config2) {
      this.maxContinuousChecks = config2.skipFrames;
      this.detectionConfidence = config2.minConfidence;
      this.maxHands = config2.maxHands;
      const useFreshBox = this.shouldUpdateRegionsOfInterest();
      if (useFreshBox === true) {
        const boundingBoxPredictions = await this.boundingBoxDetector.estimateHandBounds(image, config2);
        this.regionsOfInterest = [];
        for (const i in boundingBoxPredictions) {
          this.updateRegionsOfInterest(boundingBoxPredictions[i], true, i);
        }
        this.runsWithoutHandDetector = 0;
      } else {
        this.runsWithoutHandDetector++;
      }
      const hands = [];
      if (!this.regionsOfInterest)
        return hands;
      for (const i in this.regionsOfInterest) {
        const currentBox = this.regionsOfInterest[i][0];
        if (!currentBox)
          return hands;
        const angle = util.computeRotation(currentBox.palmLandmarks[PALM_LANDMARKS_INDEX_OF_PALM_BASE], currentBox.palmLandmarks[PALM_LANDMARKS_INDEX_OF_MIDDLE_FINGER_BASE]);
        const palmCenter = bounding.getBoxCenter(currentBox);
        const palmCenterNormalized = [palmCenter[0] / image.shape[2], palmCenter[1] / image.shape[1]];
        const rotatedImage = tf2.image.rotateWithOffset(image, angle, 0, palmCenterNormalized);
        const rotationMatrix = util.buildRotationMatrix(-angle, palmCenter);
        const box = useFreshBox ? this.getBoxForPalmLandmarks(currentBox.palmLandmarks, rotationMatrix) : currentBox;
        const croppedInput = bounding.cutBoxFromImageAndResize(box, rotatedImage, [this.meshWidth, this.meshHeight]);
        const handImage = croppedInput.div(255);
        croppedInput.dispose();
        rotatedImage.dispose();
        const prediction = this.meshDetector.predict(handImage);
        const [flag, keypoints] = prediction;
        handImage.dispose();
        const flagValue = flag.dataSync()[0];
        flag.dispose();
        if (flagValue < config2.minConfidence) {
          keypoints.dispose();
          this.regionsOfInterest[i] = [];
          return hands;
        }
        const keypointsReshaped = tf2.reshape(keypoints, [-1, 3]);
        const rawCoords = await keypointsReshaped.array();
        keypoints.dispose();
        keypointsReshaped.dispose();
        const coords = this.transformRawCoords(rawCoords, box, angle, rotationMatrix);
        const nextBoundingBox = this.getBoxForHandLandmarks(coords);
        this.updateRegionsOfInterest(nextBoundingBox, false, i);
        const result = {
          landmarks: coords,
          confidence: flagValue,
          box: {
            topLeft: nextBoundingBox.startPoint,
            bottomRight: nextBoundingBox.endPoint
          }
        };
        hands.push(result);
      }
      return hands;
    }
    calculateLandmarksBoundingBox(landmarks) {
      const xs = landmarks.map((d) => d[0]);
      const ys = landmarks.map((d) => d[1]);
      const startPoint = [Math.min(...xs), Math.min(...ys)];
      const endPoint = [Math.max(...xs), Math.max(...ys)];
      return {startPoint, endPoint};
    }
    updateRegionsOfInterest(box, forceUpdate, index) {
      if (forceUpdate) {
        this.regionsOfInterest[index] = [box];
      } else {
        const previousBox = this.regionsOfInterest[index][0];
        let iou = 0;
        if (previousBox != null && previousBox.startPoint != null) {
          const [boxStartX, boxStartY] = box.startPoint;
          const [boxEndX, boxEndY] = box.endPoint;
          const [previousBoxStartX, previousBoxStartY] = previousBox.startPoint;
          const [previousBoxEndX, previousBoxEndY] = previousBox.endPoint;
          const xStartMax = Math.max(boxStartX, previousBoxStartX);
          const yStartMax = Math.max(boxStartY, previousBoxStartY);
          const xEndMin = Math.min(boxEndX, previousBoxEndX);
          const yEndMin = Math.min(boxEndY, previousBoxEndY);
          const intersection = (xEndMin - xStartMax) * (yEndMin - yStartMax);
          const boxArea = (boxEndX - boxStartX) * (boxEndY - boxStartY);
          const previousBoxArea = (previousBoxEndX - previousBoxStartX) * (previousBoxEndY - boxStartY);
          iou = intersection / (boxArea + previousBoxArea - intersection);
        }
        this.regionsOfInterest[index][0] = iou > UPDATE_REGION_OF_INTEREST_IOU_THRESHOLD ? previousBox : box;
      }
    }
    shouldUpdateRegionsOfInterest() {
      return !this.regionsOfInterest || this.regionsOfInterest.length === 0 || this.runsWithoutHandDetector >= this.maxContinuousChecks;
    }
  }
  exports2.HandPipeline = HandPipeline;
});

// src/handpose/handpose.js
var require_handpose = __commonJS((exports2) => {
  const tf2 = require("@tensorflow/tfjs");
  const hand = require_handdetector();
  const keypoints = require_keypoints3();
  const pipe = require_pipeline2();
  class HandPose {
    constructor(pipeline) {
      this.pipeline = pipeline;
    }
    async estimateHands(input, config2) {
      this.maxContinuousChecks = config2.skipFrames;
      this.detectionConfidence = config2.minConfidence;
      this.maxHands = config2.maxHands;
      const image = tf2.tidy(() => {
        if (!(input instanceof tf2.Tensor)) {
          input = tf2.browser.fromPixels(input);
        }
        return input.toFloat().expandDims(0);
      });
      const predictions = await this.pipeline.estimateHands(image, config2);
      image.dispose();
      const hands = [];
      if (!predictions)
        return hands;
      for (const prediction of predictions) {
        if (!prediction)
          return [];
        const annotations = {};
        for (const key of Object.keys(keypoints.MESH_ANNOTATIONS)) {
          annotations[key] = keypoints.MESH_ANNOTATIONS[key].map((index) => prediction.landmarks[index]);
        }
        hands.push({
          confidence: prediction.confidence || 0,
          box: prediction.box ? [prediction.box.topLeft[0], prediction.box.topLeft[1], prediction.box.bottomRight[0] - prediction.box.topLeft[0], prediction.box.bottomRight[1] - prediction.box.topLeft[1]] : 0,
          landmarks: prediction.landmarks,
          annotations
        });
      }
      return hands;
    }
  }
  exports2.HandPose = HandPose;
  async function loadAnchors(url) {
    if (tf2.env().features.IS_NODE) {
      const fs = require("fs");
      const data = await fs.readFileSync(url.replace("file://", ""));
      return JSON.parse(data);
    }
    return tf2.util.fetch(url).then((d) => d.json());
  }
  async function load(config2) {
    const [anchors, handDetectorModel, handPoseModel] = await Promise.all([
      loadAnchors(config2.detector.anchors),
      tf2.loadGraphModel(config2.detector.modelPath, {fromTFHub: config2.detector.modelPath.includes("tfhub.dev")}),
      tf2.loadGraphModel(config2.skeleton.modelPath, {fromTFHub: config2.skeleton.modelPath.includes("tfhub.dev")})
    ]);
    const detector = new hand.HandDetector(handDetectorModel, anchors, config2);
    const pipeline = new pipe.HandPipeline(detector, handPoseModel, config2);
    const handpose2 = new HandPose(pipeline);
    return handpose2;
  }
  exports2.load = load;
});

// src/config.js
var require_config = __commonJS((exports2) => {
  __export(exports2, {
    default: () => config_default
  });
  var config_default = {
    backend: "webgl",
    console: true,
    face: {
      enabled: true,
      detector: {
        modelPath: "../models/blazeface/back/model.json",
        inputSize: 256,
        maxFaces: 10,
        skipFrames: 10,
        minConfidence: 0.5,
        iouThreshold: 0.3,
        scoreThreshold: 0.7
      },
      mesh: {
        enabled: true,
        modelPath: "../models/facemesh/model.json",
        inputSize: 192
      },
      iris: {
        enabled: true,
        modelPath: "../models/iris/model.json",
        enlargeFactor: 2.3,
        inputSize: 64
      },
      age: {
        enabled: true,
        modelPath: "../models/ssrnet-age/imdb/model.json",
        inputSize: 64,
        skipFrames: 10
      },
      gender: {
        enabled: true,
        minConfidence: 0.8,
        modelPath: "../models/ssrnet-gender/imdb/model.json"
      },
      emotion: {
        enabled: true,
        inputSize: 64,
        minConfidence: 0.5,
        skipFrames: 10,
        useGrayscale: true,
        modelPath: "../models/emotion/model.json"
      }
    },
    body: {
      enabled: true,
      modelPath: "../models/posenet/model.json",
      inputResolution: 257,
      outputStride: 16,
      maxDetections: 10,
      scoreThreshold: 0.7,
      nmsRadius: 20
    },
    hand: {
      enabled: true,
      inputSize: 256,
      skipFrames: 10,
      minConfidence: 0.5,
      iouThreshold: 0.3,
      scoreThreshold: 0.7,
      enlargeFactor: 1.65,
      maxHands: 10,
      detector: {
        anchors: "../models/handdetect/anchors.json",
        modelPath: "../models/handdetect/model.json"
      },
      skeleton: {
        modelPath: "../models/handskeleton/model.json"
      }
    }
  };
});

// package.json
var require_package = __commonJS((exports2, module2) => {
  module2.exports = {
    name: "@vladmandic/human",
    version: "0.3.3",
    description: "human: 3D Face Detection, Iris Tracking and Age & Gender Prediction",
    sideEffects: false,
    main: "dist/human-nobundle.cjs",
    module: "dist/human.esm.js",
    browser: "dist/human.esm.js",
    author: "Vladimir Mandic <mandic00@live.com>",
    bugs: {
      url: "https://github.com/vladmandic/human/issues"
    },
    homepage: "https://github.com/vladmandic/human#readme",
    license: "MIT",
    engines: {
      node: ">=14.0.0"
    },
    repository: {
      type: "git",
      url: "git+https://github.com/vladmandic/human.git"
    },
    dependencies: {},
    peerDependencies: {},
    devDependencies: {
      "@tensorflow/tfjs": "^2.6.0",
      "@tensorflow/tfjs-node": "^2.6.0",
      esbuild: "^0.7.15",
      eslint: "^7.10.0",
      "eslint-config-airbnb-base": "^14.2.0",
      "eslint-plugin-import": "^2.22.1",
      "eslint-plugin-json": "^2.1.2",
      "eslint-plugin-node": "^11.1.0",
      "eslint-plugin-promise": "^4.2.1",
      rimraf: "^3.0.2"
    },
    scripts: {
      start: "node --trace-warnings --trace-uncaught --no-deprecation demo/demo-node.js",
      lint: "eslint src/*.js demo/*.js",
      "build-iife": "esbuild --bundle --platform=browser --sourcemap --target=esnext --format=iife --minify --external:fs --global-name=human --outfile=dist/human.js src/index.js",
      "build-esm-bundle": "esbuild --bundle --platform=browser --sourcemap --target=esnext --format=esm --minify --external:fs --outfile=dist/human.esm.js src/index.js",
      "build-esm-nobundle": "esbuild --bundle --platform=browser --sourcemap --target=esnext --format=esm --minify --external:@tensorflow --external:fs --outfile=dist/human.esm-nobundle.js src/index.js",
      "build-node-bundle": "esbuild --bundle --platform=node --sourcemap --target=esnext --format=cjs --minify --outfile=dist/human.cjs src/index.js",
      "build-node-nobundle": "esbuild --bundle --platform=node --sourcemap --target=esnext --format=cjs --external:@tensorflow --outfile=dist/human-nobundle.cjs src/index.js",
      build: "rimraf dist/* && npm run build-iife && npm run build-esm-bundle && npm run build-esm-nobundle && npm run build-node-bundle && npm run build-node-nobundle && ls -l dist/",
      update: "npm update --depth 20 && npm dedupe && npm prune && npm audit"
    },
    keywords: [
      "tensorflowjs",
      "face-detection",
      "face-geometry",
      "body-tracking",
      "hand-tracking",
      "iris-tracking",
      "age-estimation",
      "emotion-detection",
      "gender-prediction",
      "gesture-recognition"
    ]
  };
});

// src/index.js
const tf = require("@tensorflow/tfjs");
const facemesh = require_facemesh();
const ssrnet = require_ssrnet();
const emotion = require_emotion();
const posenet = require_posenet();
const handpose = require_handpose();
const defaults = require_config().default;
const app = require_package();
let config;
const models = {
  facemesh: null,
  posenet: null,
  handpose: null,
  iris: null,
  age: null,
  gender: null,
  emotion: null
};
const now = () => {
  if (typeof performance !== "undefined")
    return performance.now();
  return parseInt(Number(process.hrtime.bigint()) / 1e3 / 1e3);
};
const log = (...msg) => {
  if (config.console)
    console.log(...msg);
};
function mergeDeep(...objects) {
  const isObject = (obj) => obj && typeof obj === "object";
  return objects.reduce((prev, obj) => {
    Object.keys(obj || {}).forEach((key) => {
      const pVal = prev[key];
      const oVal = obj[key];
      if (Array.isArray(pVal) && Array.isArray(oVal)) {
        prev[key] = pVal.concat(...oVal);
      } else if (isObject(pVal) && isObject(oVal)) {
        prev[key] = mergeDeep(pVal, oVal);
      } else {
        prev[key] = oVal;
      }
    });
    return prev;
  }, {});
}
function sanity(input) {
  if (!input)
    return "input is not defined";
  const width = input.naturalWidth || input.videoWidth || input.width || input.shape && input.shape[1] > 0;
  if (!width || width === 0)
    return "input is empty";
  if (input.readyState && input.readyState <= 2)
    return "input is not ready";
  try {
    tf.getBackend();
  } catch {
    return "backend not loaded";
  }
  return null;
}
async function detect(input, userConfig) {
  config = mergeDeep(defaults, userConfig);
  const error = sanity(input);
  if (error) {
    log(error, input);
    return {error};
  }
  return new Promise(async (resolve) => {
    const loadedModels = Object.values(models).filter((a) => a).length;
    if (loadedModels === 0)
      log("Human library starting");
    if (tf.getBackend() !== config.backend) {
      log("Human library setting backend:", config.backend);
      await tf.setBackend(config.backend);
      await tf.ready();
    }
    if (config.face.enabled && !models.facemesh)
      models.facemesh = await facemesh.load(config.face);
    if (config.body.enabled && !models.posenet)
      models.posenet = await posenet.load(config.body);
    if (config.hand.enabled && !models.handpose)
      models.handpose = await handpose.load(config.hand);
    if (config.face.enabled && config.face.age.enabled && !models.age)
      models.age = await ssrnet.loadAge(config);
    if (config.face.enabled && config.face.gender.enabled && !models.gender)
      models.gender = await ssrnet.loadGender(config);
    if (config.face.enabled && config.face.emotion.enabled && !models.emotion)
      models.emotion = await emotion.load(config);
    const perf = {};
    let timeStamp;
    timeStamp = now();
    tf.engine().startScope();
    const poseRes = config.body.enabled ? await models.posenet.estimatePoses(input, config.body) : [];
    tf.engine().endScope();
    perf.body = Math.trunc(now() - timeStamp);
    timeStamp = now();
    tf.engine().startScope();
    const handRes = config.hand.enabled ? await models.handpose.estimateHands(input, config.hand) : [];
    tf.engine().endScope();
    perf.hand = Math.trunc(now() - timeStamp);
    const faceRes = [];
    if (config.face.enabled) {
      timeStamp = now();
      tf.engine().startScope();
      const faces = await models.facemesh.estimateFaces(input, config.face);
      perf.face = Math.trunc(now() - timeStamp);
      for (const face of faces) {
        if (!face.image || face.image.isDisposedInternal) {
          log("face object is disposed:", face.image);
          continue;
        }
        timeStamp = now();
        const ssrData = config.face.age.enabled || config.face.gender.enabled ? await ssrnet.predict(face.image, config) : {};
        perf.agegender = Math.trunc(now() - timeStamp);
        timeStamp = now();
        const emotionData = config.face.emotion.enabled ? await emotion.predict(face.image, config) : {};
        perf.emotion = Math.trunc(now() - timeStamp);
        face.image.dispose();
        const iris = face.annotations.leftEyeIris && face.annotations.rightEyeIris ? Math.max(face.annotations.leftEyeIris[3][0] - face.annotations.leftEyeIris[1][0], face.annotations.rightEyeIris[3][0] - face.annotations.rightEyeIris[1][0]) : 0;
        faceRes.push({
          confidence: face.confidence,
          box: face.box,
          mesh: face.mesh,
          annotations: face.annotations,
          age: ssrData.age,
          gender: ssrData.gender,
          agConfidence: ssrData.confidence,
          emotion: emotionData,
          iris: iris !== 0 ? Math.trunc(100 * 11.7 / iris) / 100 : 0
        });
      }
      tf.engine().endScope();
    }
    perf.total = Object.values(perf).reduce((a, b) => a + b);
    resolve({face: faceRes, body: poseRes, hand: handRes, performance: perf});
  });
}
exports.detect = detect;
exports.defaults = defaults;
exports.config = config;
exports.models = models;
exports.facemesh = facemesh;
exports.ssrnet = ssrnet;
exports.posenet = posenet;
exports.handpose = handpose;
exports.tf = tf;
exports.version = app.version;
//# sourceMappingURL=human-nobundle.cjs.map
