import type { Types } from '@cornerstonejs/core';
import {
  RenderingEngine,
  Enums,
  volumeLoader,
  setVolumesForViewports,
  CONSTANTS,
  utilities,
} from '@cornerstonejs/core';
import {
  initDemo,
  createImageIdsAndCacheMetaData,
  setTitleAndDescription,
} from '../../../../utils/demo/helpers';
import * as cornerstoneTools from '@cornerstonejs/tools';
import addDropDownToToolbar from '../../../../utils/demo/helpers/addDropdownToToolbar';
import setPetTransferFunction from '../../../../utils/demo/helpers/setPetTransferFunctionForVolumeActor';
import { VolumeRotateTool } from '@cornerstonejs/tools';
import ImageHelper from '@kitware/vtk.js/Common/Core/ImageHelper';
import vtkTexture from '@kitware/vtk.js/Rendering/Core/Texture';
import vtkCubeSource from '@kitware/vtk.js/Filters/Sources/CubeSource';
import vtkActor from '@kitware/vtk.js/Rendering/Core/Actor';
import '@kitware/vtk.js/Rendering/Profiles/All'; // If you want all profiles

async function getImageStacks() {
  const wadoRsRoot1 = 'https://d14fa38qiwhyfd.cloudfront.net/dicomweb';
  const studyInstanceUID =
    '1.3.6.1.4.1.25403.345050719074.3824.20170125095258.1';
  const seriesInstanceUIDs = [
    '1.3.6.1.4.1.25403.345050719074.3824.20170125095258.7',
  ];
  const ctImageIds = await createImageIdsAndCacheMetaData({
    StudyInstanceUID: studyInstanceUID,
    SeriesInstanceUID: seriesInstanceUIDs[0],
    wadoRsRoot: wadoRsRoot1,
  });

  const wadoRsRoot = 'https://d14fa38qiwhyfd.cloudfront.net/dicomweb';
  const StudyInstanceUID =
    '1.3.6.1.4.1.14519.5.2.1.7009.2403.334240657131972136850343327463';

  const ptImageIds = await createImageIdsAndCacheMetaData({
    StudyInstanceUID,
    SeriesInstanceUID:
      '1.3.6.1.4.1.14519.5.2.1.7009.2403.879445243400782656317561081015',
    wadoRsRoot,
  });

  return [ctImageIds, ptImageIds];
}
// This is for debugging purposes
console.warn(
  'Click on index.ts to open source code for this example --------->'
);

const {
  ToolGroupManager,
  Enums: csToolsEnums,
  OrientationMarkerTool,
  ZoomTool,
  PanTool,
  StackScrollTool,
  TrackballRotateTool,
} = cornerstoneTools;

const ctToolGroupId = 'CT_TOOLGROUP_ID';
const ptToolGroupId = 'PT_TOOLGROUP_ID';
let ctToolGroup;
let ptToolGroup;

function getConfig(value) {
  return {
    overlayMarkerType: OrientationMarkerTool.OVERLAY_MARKER_TYPES[value],
    overlayConfiguration: {
      [OrientationMarkerTool.OVERLAY_MARKER_TYPES.ANNOTATED_CUBE]: {
        faceProperties: {
          xPlus: {
            text: ['A', 'B', 'C', 'D', 'E'],
            faceColor: '#ffff00',
            faceRotation: 270,
          },
          xMinus: {
            text: ['F', 'G', 'H', 'I', 'J'],
            faceColor: '#ffff00',
            faceRotation: 0,
          },
          yPlus: {
            text: ['K', 'L', 'M', 'N', 'O'],
            faceColor: '#00ffff',
            fontColor: 'white',
            faceRotation: 0,
          },
          yMinus: {
            text: ['P', 'Q', 'R', 'S', 'T'],
            faceColor: '#00ffff',
            fontColor: 'white',
            faceRotation: 180,
          },
          zPlus: {
            text: ['U', 'V', 'W', 'X', 'Y'],
            faceColor: '#ff00ff',
            fontColor: 'white',
          },
          zMinus: {
            text: ['A', 'F', 'P', 'R', 'L'],
            faceColor: '#ff00ff',
            fontColor: 'white',
          },
        },
        defaultStyle: {
          fontStyle: 'bold',
          fontFamily: 'Arial',
          fontColor: 'black',
          fontSizeScale: (res) => res / 4,
          faceColor: '#0000ff',
          edgeThickness: 0.1,
          edgeColor: 'black',
          resolution: 400,
        },
      },
      [OrientationMarkerTool.OVERLAY_MARKER_TYPES.AXES]: {},
      [OrientationMarkerTool.OVERLAY_MARKER_TYPES.CUSTOM]: {
        polyDataURL:
          'https://raw.githubusercontent.com/Slicer/Slicer/80ad0a04dacf134754459557bf2638c63f3d1d1b/Base/Logic/Resources/OrientationMarkers/Human.vtp',
      },
    },
  };
}

addDropDownToToolbar({
  options: {
    values: Object.keys(OrientationMarkerTool.OVERLAY_MARKER_TYPES),
    defaultValue: OrientationMarkerTool.OVERLAY_MARKER_TYPES.AXES,
  },
  onSelectedValueChange: (value) => {
    [ctToolGroup, ptToolGroup].forEach((toolGroup) => {
      toolGroup.setToolDisabled(OrientationMarkerTool.toolName);
      toolGroup.setToolConfiguration(
        OrientationMarkerTool.toolName,
        getConfig(value)
      );

      toolGroup.setToolEnabled(OrientationMarkerTool.toolName);
    });
  },
});

const { MouseBindings } = csToolsEnums;
const { ViewportType } = Enums;

// Define a unique id for the volume
const ctVolumeName = 'CT_VOLUME_ID'; // Id of the volume less loader prefix
const ptVolumeName = 'PT_VOLUME_ID'; // Id of the volume less loader prefix
const volumeLoaderScheme = 'cornerstoneStreamingImageVolume'; // Loader id which defines which volume loader to use
const ctVolumeId = `${volumeLoaderScheme}:${ctVolumeName}`;
const ptVolumeId = `${volumeLoaderScheme}:${ptVolumeName}`;
const toolGroupId = 'MY_TOOLGROUP_ID';

// ======== Set up page ======== //
setTitleAndDescription(
  'Orientation Marker',
  'Here we demonstrate Orientation marker tool working .'
);

const size = '500px';
const content = document.getElementById('content');
const viewportGrid = document.createElement('div');

viewportGrid.style.display = 'flex';
viewportGrid.style.display = 'flex';
viewportGrid.style.flexDirection = 'row';

const elements = [];
const numberOfElements = 3;
for (let i = 0; i < numberOfElements; i++) {
  const element = document.createElement('div');
  element.style.width = size;
  element.style.height = size;
  // Disable right click context menu so we can have right click tools
  element.oncontextmenu = (e) => e.preventDefault();
  viewportGrid.appendChild(element);
  elements.push(element);
}

content.appendChild(viewportGrid);

const instructions = document.createElement('p');
instructions.innerText = `
  `;

content.append(instructions);

const viewportIds = ['CT_AXIAL', 'CT_SAGITTAL', 'CT_CORONAL'].slice(
  0,
  numberOfElements
);

const renderingEngineId = 'myRenderingEngine';

/**
 * Runs the demo
 */
async function run() {
  // Define tool groups to add the segmentation display tool to
  ctToolGroup = ToolGroupManager.createToolGroup(ctToolGroupId);
  ptToolGroup = ToolGroupManager.createToolGroup(ptToolGroupId);

  // Init Cornerstone and related libraries
  await initDemo();

  // Add tools to Cornerstone3D
  cornerstoneTools.addTool(OrientationMarkerTool);
  cornerstoneTools.addTool(PanTool);
  cornerstoneTools.addTool(ZoomTool);
  cornerstoneTools.addTool(StackScrollTool);
  cornerstoneTools.addTool(TrackballRotateTool);
  cornerstoneTools.addTool(VolumeRotateTool);

  ctToolGroup.addTool(OrientationMarkerTool.toolName);
  ctToolGroup.addTool(ZoomTool.toolName);
  ctToolGroup.addTool(PanTool.toolName);
  ctToolGroup.addTool(TrackballRotateTool.toolName);
  ctToolGroup.setToolActive(TrackballRotateTool.toolName, {
    bindings: [
      {
        mouseButton: MouseBindings.Primary, // Left Click
      },
    ],
  });
  ctToolGroup.setToolActive(ZoomTool.toolName, {
    bindings: [
      {
        mouseButton: MouseBindings.Secondary, // Left Click
      },
    ],
  });

  ptToolGroup.addTool(OrientationMarkerTool.toolName);
  ptToolGroup.addTool(ZoomTool.toolName);
  ptToolGroup.addTool(PanTool.toolName);
  ptToolGroup.addTool(StackScrollTool.toolName);
  ptToolGroup.addTool(VolumeRotateTool.toolName);
  ptToolGroup.setToolActive(VolumeRotateTool.toolName, {
    bindings: [
      {
        mouseButton: MouseBindings.Wheel,
      },
    ],
  });

  // Instantiate a rendering engine
  const renderingEngine = new RenderingEngine(renderingEngineId);

  // Create the viewports
  const viewportInputArray = [
    {
      viewportId: viewportIds[0],
      type: ViewportType.ORTHOGRAPHIC,
      element: elements[0],
      defaultOptions: {
        orientation: Enums.OrientationAxis.AXIAL,
      },
    },
    {
      viewportId: viewportIds[1],
      type: ViewportType.ORTHOGRAPHIC,
      element: elements[1],
      defaultOptions: {
        orientation: Enums.OrientationAxis.SAGITTAL,
      },
    },
    {
      viewportId: viewportIds[2],
      type: ViewportType.ORTHOGRAPHIC,
      element: elements[2],
      defaultOptions: {
        orientation: Enums.OrientationAxis.CORONAL,
        background: [1, 1, 1],
      },
    },
  ];

  // @ts-ignore
  renderingEngine.setViewports(viewportInputArray);

  const [ctImageIds, ptImageIds] = await getImageStacks();

  // Define a volume in memory
  const ctVolume = await volumeLoader.createAndCacheVolume(ctVolumeId, {
    imageIds: ctImageIds,
  });
  const ptVolume = await volumeLoader.createAndCacheVolume(ptVolumeId, {
    imageIds: ptImageIds,
  });

  ctVolume.load();
  ptVolume.load();

  ctToolGroup.addViewport(viewportIds[0], renderingEngineId);
  ctToolGroup.addViewport(viewportIds[1], renderingEngineId);
  ptToolGroup.addViewport(viewportIds[2], renderingEngineId);

  const ctViewportIds = viewportIds.slice(0, 2);

  setVolumesForViewports(
    renderingEngine,
    [
      {
        volumeId: ctVolumeId,
        slabThickness: 300,
      },
    ],
    [...ctViewportIds]
  ).then(() => {
    ctViewportIds.forEach((viewportId) => {
      const volumeActor = renderingEngine
        .getViewport(viewportId)
        .getDefaultActor().actor as Types.VolumeActor;

      utilities.applyPreset(
        volumeActor,
        CONSTANTS.VIEWPORT_PRESETS.find((preset) => preset.name === 'CT-Bone')
      );

      const viewport = renderingEngine.getViewport(viewportId);

      viewport.render();
    });
  });

  setVolumesForViewports(
    renderingEngine,
    [
      {
        volumeId: ptVolumeId,
        callback: setPetTransferFunction,
        blendMode: Enums.BlendModes.MAXIMUM_INTENSITY_BLEND,
        slabThickness: 300,
      },
    ],
    [viewportIds[2]]
  ).then(() => {
    const viewport = renderingEngine.getViewport(viewportIds[2]);

    viewport.render();
  });

  ctToolGroup.setToolActive(OrientationMarkerTool.toolName);
  ptToolGroup.setToolActive(OrientationMarkerTool.toolName);

  // Render the image
  renderingEngine.render();


  const canvas = document.createElement('canvas');
  canvas.width = 400;
  canvas.height = 400;
  drawLetters(canvas, ['A', 'B', 'C', 'D', 'E'], 0);
  canvas.getContext('2d').rotate(-Math.PI * (0 / 180.0)); // TODO face rotation

  const newData = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
  console.log(newData);

  window.re = renderingEngine;

  // window.tx = renderingEngine.getViewports()[0].getWidgets()[0].getActor().getTextures()[0]

  /*
  const actor = renderingEngine.getViewports()[0].getWidgets()[0].getActor();
  // const mapper = actor.getMapper()
  // const texture = vtkTexture.newInstance();
  const texture = actor.getTextures()[0]
  // const vtkImage = ImageHelper.canvasToImageData(canvas);
  const vtkImage = texture.getInputData(5).getPointData().getScalars().setData(new Uint8Array(newData.data));
  // texture.getInputData().getPointData().getScalars().setData(newData.data);
  // texture.setInputData(vtkImage, 5);
  texture.modified();
  // texture.setCanvas(canvas);
  window.actor = actor;
  // actor.removeAllTextures();
  // actor.addTexture(texture);
  actor.modified();
  */

  /*
  const oldActor = renderingEngine.getViewports()[0].getWidgets()[0].getActor();
  const oldTexture = oldActor.getTextures()[0]

  const texture = vtkTexture.newInstance();
  const vtkImage = ImageHelper.canvasToImageData(canvas);
  texture.setInputData(vtkImage, 5);

  const widget = renderingEngine.getViewports()[0].getWidgets()[0]
  window.widget = widget;
  const mapper = oldActor.getMapper();
  const cubeSource = vtkCubeSource.newInstance({
    generate3DTextureCoordinates: true,
  });
  mapper.setInputConnection(cubeSource.getOutputPort());

  const actor = vtkActor.newInstance();
  actor.setVisibility(true);
  actor.setMapper(mapper);
  // actor.addTexture(oldTexture);
  actor.addTexture(texture);
  actor.modified();

  widget.setActor(actor);
  widget.updateViewport();
  */
}

run();

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
