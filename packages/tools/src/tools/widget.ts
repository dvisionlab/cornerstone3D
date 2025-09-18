import macro from '@kitware/vtk.js/macros';
import vtkActor from '@kitware/vtk.js/Rendering/Core/Actor';
import vtkMapper from '@kitware/vtk.js/Rendering/Core/Mapper';
import vtkTexture from '@kitware/vtk.js/Rendering/Core/Texture';
import vtkCubeSource from '@kitware/vtk.js/Filters/Sources/CubeSource';
import ImageHelper from '@kitware/vtk.js/Common/Core/ImageHelper';

import Presets from '@kitware/vtk.js/Rendering/Core/AnnotatedCubeActor/Presets';

const FACE_TO_INDEX = {
  xPlus: 0,
  xMinus: 1,
  yPlus: 2,
  yMinus: 3,
  zPlus: 4,
  zMinus: 5,
};

/**
 * Draws a cross-shaped arrangement of letters on the canvas.
 * The letters are positioned as:
 * [0] (top)
 * [3] [1] [4] (middle row: left, center, right)
 * [2] (bottom)
 *
 * @param {string[]} letters An array of 5 single-character strings
 * in the order: [top, center, bottom, left, right].
 */
function drawLetters(canvas, letters, faceRotation) {
  const ctx = canvas.getContext('2d');

  // Clear the canvas before redrawing
  // ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Fill the background with black
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Flip the canvas vertically
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);

  // TODO rotate

  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(-Math.PI * (faceRotation / 180.0));
  ctx.translate(-canvas.width / 2, -canvas.height / 2);

  // Set text color
  ctx.fillStyle = '#000000';

  // Calculate the center of the canvas
  const centerX = canvas.width / 2;
  // Adjusted centerY to move the entire group down by a smaller percentage of canvas height
  const centerY = canvas.height / 2 + canvas.height * 0.02; // Move down by 2% of canvas height

  // Base font size for A, C, D, E (adjust dynamically)
  const baseFontSize = (canvas.height / 3) * 0.7;

  // Larger font size for B (the center letter)
  const bFontSize = baseFontSize * 1.5; // B will be 50% larger than others

  // Define spacing based on the larger 'B' font size to ensure enough room
  const spacing = bFontSize * 1.0; // Adjust this multiplier for desired gap

  // Draw the center letter (index 1 in the array) first with its larger font size
  ctx.font = `${bFontSize}px Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(letters[1], centerX, centerY); // Draw 'B'

  // Now draw other letters, resetting font and adjusting positions relative to the center
  ctx.font = `${baseFontSize}px Arial, sans-serif`;

  // Position for the top letter (index 0)
  const centerY_A = centerY - spacing;
  ctx.fillText(letters[0], centerX, centerY_A); // Draw 'A'

  // Position for the bottom letter (index 2)
  const centerY_C = centerY + spacing;
  ctx.fillText(letters[2], centerX, centerY_C); // Draw 'C'

  // Position for the left letter (index 3)
  const centerX_D = centerX - spacing;
  ctx.fillText(letters[3], centerX_D, centerY); // Draw 'D'

  // Position for the right letter (index 4)
  const centerX_E = centerX + spacing;
  ctx.fillText(letters[4], centerX_E, centerY); // Draw 'E'

  ctx.restore();
}

// ----------------------------------------------------------------------------
// vtkAnnotatedCubeActor
// ----------------------------------------------------------------------------

function vtkAnnotatedCubeActor(publicAPI, model) {
  // Set our className
  model.classHierarchy.push('vtkAnnotatedCubeActor');

  // Make sure face properties are not references to the default value
  model.xPlusFaceProperty = { ...model.xPlusFaceProperty };
  model.xMinusFaceProperty = { ...model.xMinusFaceProperty };
  model.yPlusFaceProperty = { ...model.yPlusFaceProperty };
  model.yMinusFaceProperty = { ...model.yMinusFaceProperty };
  model.zPlusFaceProperty = { ...model.zPlusFaceProperty };
  model.zMinusFaceProperty = { ...model.zMinusFaceProperty };

  // private variables

  let cubeSource = null;

  const canvas = document.createElement('canvas');
  const mapper = vtkMapper.newInstance();
  const texture = vtkTexture.newInstance();
  texture.setInterpolate(true);

  // private methods

  function updateFaceTexture(faceName, newProp = null) {
    if (newProp) {
      Object.assign(model[`${faceName}FaceProperty`], newProp);
    }

    const prop = {
      ...model.defaultStyle,
      ...model[`${faceName}FaceProperty`],
    };

    // set canvas resolution
    canvas.width = prop.resolution;
    canvas.height = prop.resolution;

    // const ctxt = canvas.getContext('2d');
    drawLetters(canvas, prop.text, prop.faceRotation);

    /*
    // set background color
    ctxt.fillStyle = prop.faceColor;
    ctxt.fillRect(0, 0, canvas.width, canvas.height);

    // draw edge
    if (prop.edgeThickness > 0) {
      ctxt.strokeStyle = prop.edgeColor;
      ctxt.lineWidth = prop.edgeThickness * canvas.width;
      ctxt.strokeRect(0, 0, canvas.width, canvas.height);
    }

    // set face rotation
    ctxt.save();

    // vertical flip
    ctxt.translate(0, canvas.height);
    ctxt.scale(1, -1);

    ctxt.translate(canvas.width / 2, canvas.height / 2);
    ctxt.rotate(-Math.PI * (prop.faceRotation / 180.0));

    // set foreground text
    const textSize = prop.fontSizeScale(prop.resolution);
    ctxt.fillStyle = prop.fontColor;
    ctxt.textAlign = 'center';
    ctxt.textBaseline = 'middle';
    ctxt.font = `${prop.fontStyle} ${textSize}px "${prop.fontFamily}"`;
    ctxt.fillText(prop.text, 0, 0);

    */

    const vtkImage = ImageHelper.canvasToImageData(canvas);
    texture.setInputData(vtkImage, FACE_TO_INDEX[faceName]);
    publicAPI.modified();
  }

  function updateAllFaceTextures() {
    cubeSource = vtkCubeSource.newInstance({
      generate3DTextureCoordinates: true,
    });

    mapper.setInputConnection(cubeSource.getOutputPort());

    updateFaceTexture('xPlus');
    updateFaceTexture('xMinus');
    updateFaceTexture('yPlus');
    updateFaceTexture('yMinus');
    updateFaceTexture('zPlus');
    updateFaceTexture('zMinus');
  }

  // public methods

  publicAPI.setDefaultStyle = (style) => {
    model.defaultStyle = { ...model.defaultStyle, ...style };
    updateAllFaceTextures();
  };

  publicAPI.setXPlusFaceProperty = (prop) => updateFaceTexture('xPlus', prop);
  publicAPI.setXMinusFaceProperty = (prop) => updateFaceTexture('xMinus', prop);
  publicAPI.setYPlusFaceProperty = (prop) => updateFaceTexture('yPlus', prop);
  publicAPI.setYMinusFaceProperty = (prop) => updateFaceTexture('yMinus', prop);
  publicAPI.setZPlusFaceProperty = (prop) => updateFaceTexture('zPlus', prop);
  publicAPI.setZMinusFaceProperty = (prop) => updateFaceTexture('zMinus', prop);

  // constructor

  updateAllFaceTextures();

  // set mapper
  mapper.setInputConnection(cubeSource.getOutputPort());
  publicAPI.setMapper(mapper);

  // set texture
  publicAPI.addTexture(texture);
}

// ----------------------------------------------------------------------------
// Object factory
// ----------------------------------------------------------------------------

export const DEFAULT_VALUES = {
  defaultStyle: {
    text: '',
    faceColor: 'white',
    faceRotation: 0,
    fontFamily: 'Arial',
    fontColor: 'black',
    fontStyle: 'normal',
    fontSizeScale: (resolution) => resolution / 1.8,
    edgeThickness: 0.1,
    edgeColor: 'black',
    resolution: 200,
  },
  // xPlusFaceProperty: null,
  // xMinusFaceProperty: null,
  // yPlusFaceProperty: null,
  // yMinusFaceProperty: null,
  // zPlusFaceProperty: null,
  // zMinusFaceProperty: null,
};

// ----------------------------------------------------------------------------

export function extend(publicAPI, model, initialValues = {}) {
  Object.assign(model, DEFAULT_VALUES, initialValues);

  // Inheritance
  vtkActor.extend(publicAPI, model, initialValues);

  macro.get(publicAPI, model, [
    'defaultStyle',
    'xPlusFaceProperty',
    'xMinusFaceProperty',
    'yPlusFaceProperty',
    'yMinusFaceProperty',
    'zPlusFaceProperty',
    'zMinusFaceProperty',
  ]);

  // Object methods
  vtkAnnotatedCubeActor(publicAPI, model);
}

// ----------------------------------------------------------------------------

export const newInstance = macro.newInstance(extend, 'vtkAnnotatedCubeActor');

// ----------------------------------------------------------------------------

export default { newInstance, extend, Presets };
