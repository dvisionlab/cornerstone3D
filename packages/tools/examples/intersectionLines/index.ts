import type { Types } from '@cornerstonejs/core';
import {
  RenderingEngine,
  Enums,
  setVolumesForViewports,
  volumeLoader,
  getRenderingEngine,
} from '@cornerstonejs/core';
import {
  initDemo,
  createImageIdsAndCacheMetaData,
  setTitleAndDescription,
  setCtTransferFunctionForVolumeActor,
  getLocalUrl,
  addButtonToToolbar,
  addSliderToToolbar,
} from '../../../../utils/demo/helpers';
import * as cornerstoneTools from '@cornerstonejs/tools';

// This is for debugging purposes
console.warn(
  'Click on index.ts to open source code for this example --------->'
);

const {
  ToolGroupManager,
  Enums: csToolsEnums,
  CrosshairsTool,
  IntersectionLinesTool,
  TrackballRotateTool
} = cornerstoneTools;

const { MouseBindings } = csToolsEnums;
const { ViewportType } = Enums;

// Define a unique id for the volume
const volumeName = 'CT_VOLUME_ID'; // Id of the volume less loader prefix
const volumeLoaderScheme = 'cornerstoneStreamingImageVolume'; // Loader id which defines which volume loader to use
const volumeId = `${volumeLoaderScheme}:${volumeName}`; // VolumeId with loader id + volume id
const viewportId1 = 'axial';
const viewportId2 = 'sagittal';
const viewportId3 = 'coronal';
const viewportId4 = 'main';
const viewportIds = [viewportId1, viewportId2, viewportId3, viewportId4];
const renderingEngineId = 'renderingEngineId';

// ======== Set up page ======== //
setTitleAndDescription(
  'Intersection Lines',
  'Here we demonstrate intersection lines between 4 viewports. The first three viewports (axial, sagittal, coronal) will display intersection lines from the fourth axial viewport.'
);

const size = '200px';
const content = document.getElementById('content');
const viewportGrid = document.createElement('div');

viewportGrid.style.display = 'flex';
viewportGrid.style.flexDirection = 'row';
viewportGrid.style.flexWrap = 'wrap';

const element1 = document.createElement('div');
element1.id = viewportId1;
const element2 = document.createElement('div');
element2.id = viewportId2;
const element3 = document.createElement('div');
element3.id = viewportId3;
const element4 = document.createElement('div');
element4.id = viewportId4;

element1.style.width = size;
element1.style.height = size;
element2.style.width = size;
element2.style.height = size;
element3.style.width = size;
element3.style.height = size;
element4.style.width = size;
element4.style.height = size;

// Disable right click context menu so we can have right click tools
element1.oncontextmenu = (e) => e.preventDefault();
element2.oncontextmenu = (e) => e.preventDefault();
element3.oncontextmenu = (e) => e.preventDefault();
element4.oncontextmenu = (e) => e.preventDefault();

viewportGrid.appendChild(element1);
viewportGrid.appendChild(element2);
viewportGrid.appendChild(element3);
viewportGrid.appendChild(element4);

content.appendChild(viewportGrid);

const instructions = document.createElement('p');
instructions.innerText = `
  Basic controls:
  - Click/Drag anywhere in the viewport to move the center of the crosshairs.
  - Drag a reference line to move it, scrolling the other views.
  - The yellow lines in the first three viewports represent the intersection of their planes with the clipping planes of the fourth viewport.
  `;

content.append(instructions);

addButtonToToolbar({
  title: 'Reset Camera',
  onClick: () => {
    const renderingEngine = getRenderingEngine(renderingEngineId);
    viewportIds.forEach((viewportId) => {
      const viewport = renderingEngine.getViewport(
        viewportId
      ) as Types.IVolumeViewport;
      const resetPan = true;
      const resetZoom = true;
      const resetToCenter = true;
      const resetRotation = true;
      viewport.resetCamera({
        resetPan,
        resetZoom,
        resetToCenter,
        resetRotation,
      });

      viewport.render();
    });
  },
});

addSliderToToolbar({
  title: 'Slab Thickness',
  range: [1, 100],
  step: 1,
  defaultValue: 30,
  onSelectedValueChange: (value) => {
    const renderingEngine = getRenderingEngine(renderingEngineId);
    const viewport = renderingEngine.getViewport(viewportId4) as Types.IVolumeViewport;
    viewport.setSlabThickness(parseInt(value));
    viewport.render();
  },
});

// ============================= //

const viewportColors = {
  [viewportId1]: 'rgb(200, 0, 0)',
  [viewportId2]: 'rgb(0, 0, 200)',
  [viewportId3]: 'rgb(0, 200, 0)',
  [viewportId4]: 'rgb(200, 200, 0)',
};

function getReferenceLineColor(viewportId) {
  return viewportColors[viewportId];
}

function getReferenceLineSlabThicknessControlsOn(viewportId) {
  return false;
}

/**
 * Runs the demo
 */
async function run() {
  // Init Cornerstone and related libraries
  await initDemo();

  // Add tools to Cornerstone3D
  cornerstoneTools.addTool(CrosshairsTool);
  cornerstoneTools.addTool(IntersectionLinesTool);
  cornerstoneTools.addTool(TrackballRotateTool);

  // Get Cornerstone imageIds for the source data and fetch metadata into RAM
  const imageIds = await createImageIdsAndCacheMetaData({
    StudyInstanceUID:
      '1.3.6.1.4.1.14519.5.2.1.7009.2403.334240657131972136850343327463',
    SeriesInstanceUID:
      '1.3.6.1.4.1.14519.5.2.1.7009.2403.226151125820845824875394858561',
    wadoRsRoot:
      getLocalUrl() || 'https://d14fa38qiwhyfd.cloudfront.net/dicomweb',
  });

  // Define a volume in memory
  const volume = await volumeLoader.createAndCacheVolume(volumeId, {
    imageIds,
  });

  // Instantiate a rendering engine
  const renderingEngine = new RenderingEngine(renderingEngineId);

  // Create the viewports
  const viewportInputArray = [
    {
      viewportId: viewportId1,
      type: ViewportType.ORTHOGRAPHIC,
      element: element1,
      defaultOptions: {
        orientation: Enums.OrientationAxis.AXIAL,
        background: <Types.Point3>[0, 0, 0],
      },
    },
    {
      viewportId: viewportId2,
      type: ViewportType.ORTHOGRAPHIC,
      element: element2,
      defaultOptions: {
        orientation: Enums.OrientationAxis.SAGITTAL,
        background: <Types.Point3>[0, 0, 0],
      },
    },
    {
      viewportId: viewportId3,
      type: ViewportType.ORTHOGRAPHIC,
      element: element3,
      defaultOptions: {
        orientation: Enums.OrientationAxis.CORONAL,
        background: <Types.Point3>[0, 0, 0],
      },
    },
    {
      viewportId: viewportId4,
      type: ViewportType.ORTHOGRAPHIC,
      element: element4,
      defaultOptions: {
        orientation: Enums.OrientationAxis.AXIAL,
        background: <Types.Point3>[0, 0, 0],
      },
    },
  ];

  renderingEngine.setViewports(viewportInputArray);

  // Set the volume to load
  volume.load();

  // Set volumes on the viewports
  await setVolumesForViewports(
    renderingEngine,
    [
      {
        volumeId,
        callback: setCtTransferFunctionForVolumeActor,
      },
    ],
    viewportIds
  );

  // Define tool groups
  const toolGroup = ToolGroupManager.createToolGroup('toolGroupId');

  // Add viewports to crosshairs tool group
  toolGroup.addViewport(viewportId1, renderingEngineId);
  toolGroup.addViewport(viewportId2, renderingEngineId);
  toolGroup.addViewport(viewportId3, renderingEngineId);

  // Manipulation Tools
  const isMobile = window.matchMedia('(any-pointer:coarse)').matches;

  toolGroup.addTool(CrosshairsTool.toolName, {
    getReferenceLineColor,
    getReferenceLineSlabThicknessControlsOn,
    mobile: {
      enabled: isMobile,
      opacity: 0.8,
      handleRadius: 9,
    },
  });

  toolGroup.setToolPassive(CrosshairsTool.toolName)

  // Add IntersectionLinesTool to the first three viewports
  toolGroup.addTool(IntersectionLinesTool.toolName, {
    sourceViewportId: viewportId4,
    color: viewportColors[viewportId4],
    lineWidth: 1,
  });

  toolGroup.setToolEnabled(IntersectionLinesTool.toolName);

  // Create a second tool group for the fourth viewport
  const toolGroup2 = ToolGroupManager.createToolGroup('toolGroupId2');
  toolGroup2.addViewport(viewportId4, renderingEngineId);

  // Add TrackballRotateTool to the second tool group
  toolGroup2.addTool(TrackballRotateTool.toolName);
  toolGroup2.setToolActive(TrackballRotateTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Primary }],
  });

  const viewport = renderingEngine.getViewport(viewportId4) as Types.IVolumeViewport;
  viewport.setSlabThickness(30);
  viewport.setBlendMode(Enums.BlendModes.MAXIMUM_INTENSITY_BLEND);

  // Render the image
  renderingEngine.renderViewports(viewportIds);
}

run();
