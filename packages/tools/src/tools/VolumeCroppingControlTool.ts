import { vec2, vec3 } from 'gl-matrix';
import vtkMath from '@kitware/vtk.js/Common/Core/Math';
import type vtkPlane from '@kitware/vtk.js/Common/DataModel/Plane';

import { AnnotationTool } from './base';

import type { Types } from '@cornerstonejs/core';
import {
  getRenderingEngine,
  getEnabledElementByIds,
  getEnabledElement,
  utilities as csUtils,
  Enums,
  CONSTANTS,
  triggerEvent,
  eventTarget,
} from '@cornerstonejs/core';

import {
  getToolGroup,
} from '../store/ToolGroupManager';

import {
  addAnnotation,
  getAnnotations,
  removeAnnotation,
} from '../stateManagement/annotation/annotationState';

import { drawLine as drawLineSvg } from '../drawingSvg';
import { state } from '../store/state';
import { Events } from '../enums';
import { getViewportIdsWithToolToRender } from '../utilities/viewportFilters';
import {
  resetElementCursor,
  hideElementCursor,
} from '../cursors/elementCursor';
import liangBarksyClip from '../utilities/math/vec2/liangBarksyClip';

import drawPathWithHole, {
  calculateReferenceLines,
  calculateIntersections,
  calculateDragDelta,
  lineIntersection2D,
} from '../utilities/cropping/render';
import * as lineSegment from '../utilities/math/line';
import type {
  Annotation,
  Annotations,
  EventTypes,
  ToolHandle,
  PublicToolProps,
  ToolProps,
  InteractionTypes,
  SVGDrawingHelper,
} from '../types';
import { isAnnotationLocked } from '../stateManagement/annotation/annotationLocking';
import triggerAnnotationRenderForViewportIds from '../utilities/triggerAnnotationRenderForViewportIds';

type ReferenceLine = [
  viewport: {
    id: string;
    canvas?: HTMLCanvasElement;
    canvasToWorld?: (...args: unknown[]) => Types.Point3;
  },
  startPoint: Types.Point2,
  endPoint: Types.Point2,
  type: 'min' | 'max',
];

interface VolumeCroppingAnnotation extends Annotation {
  data: {
    handles: {
      activeOperation: number | null; // 0 translation, 1 rotation handles, 2 slab thickness handles
      toolCenter: Types.Point3;
      toolCenterMin: Types.Point3;
      toolCenterMax: Types.Point3;
    };
    activeViewportIds: string[]; // a list of the viewport ids connected to the reference lines being translated
    viewportId: string;
    referenceLines: ReferenceLine[]; // set in renderAnnotation
    clippingPlanes?: vtkPlane[]; // clipping planes for the viewport
    clippingPlaneReferenceLines?: ReferenceLine[];
    orientation?: string; // AXIAL, CORONAL, SAGITTAL
  };
}

const REFERENCE_LINE_COLOR = 'rgba(255, 255, 255, 1)';

const OPERATION = {
  DRAG: 1,
  ROTATE: 2,
  SLAB: 3,
};

/**
 * VolumeCroppingControlTool provides interactive reference lines to modify the cropping planes
 * of the VolumeCroppingTool. It renders  reference lines across 1 to 3 orthographic viewports and allows
 * users to drag these lines to adjust volume cropping boundaries in real-time.
 *
 * @remarks
 * This tool has no standalone functionality and must be used in conjunction with a VolumeCroppingTool that will be receiving volume.
 * Messaging between this tool and the main cropping tool is handled through Cornerstone events that are validated by the series instance UID of the volume.
 * Therefore the tool does not need to be in the same tool group as the volume cropping tool and
 * multiple cropping & control instances can be used on different series in the same display.
 *
 * @example
 * ```typescript
 * // Basic setup
 * const toolGroup = ToolGroupManager.createToolGroup('myToolGroup');
 * toolGroup.addTool(VolumeCroppingControlTool.toolName);
 * toolGroup.addTool(VolumeCroppingTool.toolName);
 *
 * // Configure with custom settings
 * toolGroup.setToolConfiguration(VolumeCroppingControlTool.toolName, {
 *   lineWidth: 2.0,
 * });
 *
 * // Activate the tool
 * toolGroup.setToolActive(VolumeCroppingControlTool.toolName);
 * ```
 *
 * @public
 * @class VolumeCroppingControlTool
 * @extends AnnotationTool
 *
 * @property {string} seriesInstanceUID - Frame of reference for the tool
 * @property {string} toolName - Static tool identifier: 'VolumeCroppingControl'
 * @property {Array<SphereState>} sphereStates - Array of sphere state objects for 3D volume manipulation handles
 * @property {number|null} draggingSphereIndex - Index of currently dragged sphere, null when not dragging
 * @property {Types.Point3} toolCenter - Center point of the cropping volume in world coordinates [x, y, z]
 * @property {Types.Point3} toolCenterMin - Minimum bounds of the cropping volume in world coordinates [xMin, yMin, zMin]
 * @property {Types.Point3} toolCenterMax - Maximum bounds of the cropping volume in world coordinates [xMax, yMax, zMax]
 * @property {Function} _getReferenceLineColor - Optional callback to determine reference line color per viewport
 *
 * @configuration
 * @property {number} initialCropFactor - Initial cropping factor as percentage of volume bounds (default: 0.2)
 * @property {number} lineWidth - Default width of reference lines in pixels (default: 1.5)
 * @property {number} lineWidthActive - Width of reference lines when actively dragging in pixels (default: 2.5)
 * @property {number} activeLineWidth - Alias for lineWidthActive for backward compatibility

 * @events
 * @event VOLUMECROPPINGCONTROL_TOOL_CHANGED - Fired when reference lines are dragged or tool state changes
 * @event VOLUMECROPPING_TOOL_CHANGED - Listens for changes from the main VolumeCroppingTool to synchronize state
 *
 *
 * @limitations
 * - Does not function independently without VolumeCroppingTool
 * - Requires volume data to be loaded before activation
 * - Limited to orthogonal viewport orientations (axial, coronal, sagittal)l
 */
const AXIS_MAP = {
  AXIAL: [
    { normal: [1, 0, 0], name: 'X' },
    { normal: [0, 1, 0], name: 'Y' },
  ],
  CORONAL: [
    { normal: [1, 0, 0], name: 'X' },
    { normal: [0, 0, 1], name: 'Z' },
  ],
  SAGITTAL: [
    { normal: [0, 1, 0], name: 'Y' },
    { normal: [0, 0, 1], name: 'Z' },
  ],
};

class VolumeCroppingControlTool extends AnnotationTool {
  static toolName;
  seriesInstanceUID?: string;
  sphereStates: {
    point: Types.Point3;
    axis: string;
    uid: string;
    sphereSource;
    sphereActor;
  }[] = [];
  draggingSphereIndex: number | null = null;
  toolCenter: Types.Point3 = [0, 0, 0];
  toolCenterMin: Types.Point3 = [0, 0, 0];
  toolCenterMax: Types.Point3 = [0, 0, 0];
  _getReferenceLineColor?: (viewportId: string) => string;
  constructor(
    toolProps: PublicToolProps = {},
    defaultToolProps: ToolProps = {
      supportedInteractionTypes: ['Mouse'],
      configuration: {
        initialCropFactor: 0.05,
        lineWidth: 1.5,
        lineWidthActive: 2.5,
      },
    }
  ) {
    super(toolProps, defaultToolProps);

    const viewportsInfo = getToolGroup(this.toolGroupId)?.viewportsInfo;

    if (viewportsInfo && viewportsInfo.length > 0) {
      const { viewportId, renderingEngineId } = viewportsInfo[0];
      const renderingEngine = getRenderingEngine(renderingEngineId);
      const viewport = renderingEngine.getViewport(viewportId);
      const volumeActors = viewport.getActors();
      if (!volumeActors || !volumeActors.length) {
        console.warn(
          `VolumeCroppingControlTool: No volume actors found in viewport ${viewportId}.`
        );
        return;
      }
      const imageData = volumeActors[0].actor.getMapper().getInputData();
      if (imageData) {
        const dimensions = imageData.getDimensions();
        const spacing = imageData.getSpacing();
        const origin = imageData.getOrigin();
        this.seriesInstanceUID = imageData.seriesInstanceUID || 'unknown';
        const cropFactor = this.configuration.initialCropFactor ?? 0.05;
        this.toolCenter = [
          origin[0] + cropFactor * (dimensions[0] - 1) * spacing[0],
          origin[1] + cropFactor * (dimensions[1] - 1) * spacing[1],
          origin[2] + cropFactor * (dimensions[2] - 1) * spacing[2],
        ];
        const maxCropFactor = 1 - cropFactor;
        this.toolCenterMin = [
          origin[0] + cropFactor * (dimensions[0] - 1) * spacing[0],
          origin[1] + cropFactor * (dimensions[1] - 1) * spacing[1],
          origin[2] + cropFactor * (dimensions[2] - 1) * spacing[2],
        ];
        this.toolCenterMax = [
          origin[0] + maxCropFactor * (dimensions[0] - 1) * spacing[0],
          origin[1] + maxCropFactor * (dimensions[1] - 1) * spacing[1],
          origin[2] + maxCropFactor * (dimensions[2] - 1) * spacing[2],
        ];
      }
    }
  }

  _updateToolCentersFromViewport(viewport) {
    const volumeActors = viewport.getActors();
    if (!volumeActors || !volumeActors.length) {
      return;
    }
    const imageData = volumeActors[0].actor.getMapper().getInputData();
    if (!imageData) {
      return;
    }
    this.seriesInstanceUID = imageData.seriesInstanceUID || 'unknown';
    const dimensions = imageData.getDimensions();
    const spacing = imageData.getSpacing();
    const origin = imageData.getOrigin();
    const cropFactor = this.configuration.initialCropFactor ?? 0.05;
    const cropStart = cropFactor / 2;
    const cropEnd = 1 - cropFactor / 2;
    this.toolCenter = [
      origin[0] +
      ((cropStart + cropEnd) / 2) * (dimensions[0] - 1) * spacing[0],
      origin[1] +
      ((cropStart + cropEnd) / 2) * (dimensions[1] - 1) * spacing[1],
      origin[2] +
      ((cropStart + cropEnd) / 2) * (dimensions[2] - 1) * spacing[2],
    ];
    this.toolCenterMin = [
      origin[0] + cropStart * (dimensions[0] - 1) * spacing[0],
      origin[1] + cropStart * (dimensions[1] - 1) * spacing[1],
      origin[2] + cropStart * (dimensions[2] - 1) * spacing[2],
    ];
    this.toolCenterMax = [
      origin[0] + cropEnd * (dimensions[0] - 1) * spacing[0],
      origin[1] + cropEnd * (dimensions[1] - 1) * spacing[1],
      origin[2] + cropEnd * (dimensions[2] - 1) * spacing[2],
    ];
  }
  /**
   * Gets the camera from the viewport, and adds  annotation for the viewport
   * to the annotationManager. If any annotation is found in the annotationManager, it
   * overwrites it.
   * @param viewportInfo - The viewportInfo for the viewport
   * @returns viewPlaneNormal and center of viewport canvas in world space
   */
  initializeViewport = ({
    renderingEngineId,
    viewportId,
  }: Types.IViewportId): {
    normal: Types.Point3;
    point: Types.Point3;
  } => {
    if (!renderingEngineId || !viewportId) {
      console.warn(
        'VolumeCroppingControlTool: Missing renderingEngineId or viewportId'
      );
      return;
    }
    const enabledElement = getEnabledElementByIds(
      viewportId,
      renderingEngineId
    );
    if (!enabledElement) {
      return;
    }

    const { viewport } = enabledElement;
    this._updateToolCentersFromViewport(viewport);
    const { element } = viewport;
    const { position, focalPoint, viewPlaneNormal } = viewport.getCamera();

    // Check if there is already annotation for this viewport
    let annotations = this._getAnnotations(enabledElement);
    annotations = this.filterInteractableAnnotationsForElement(
      element,
      annotations
    );

    if (annotations?.length) {
      // If found, it will override it by removing the annotation and adding it later
      removeAnnotation(annotations[0].annotationUID);
    }

    // Determine orientation from camera normal, fallback to viewportId string
    const orientation = this._getOrientationFromNormal(
      viewport.getCamera().viewPlaneNormal
    );

    const annotation = {
      highlighted: false,
      metadata: {
        cameraPosition: <Types.Point3>[...position],
        cameraFocalPoint: <Types.Point3>[...focalPoint],
        toolName: this.getToolName(),
      },
      data: {
        handles: {
          toolCenter: this.toolCenter,
          toolCenterMin: this.toolCenterMin,
          toolCenterMax: this.toolCenterMax,
        },
        activeOperation: null, // 0 translation, 1 rotation handles, 2 slab thickness handles
        activeViewportIds: [], // a list of the viewport ids connected to the reference lines being translated
        viewportId,
        referenceLines: [], // set in renderAnnotation
        orientation,
      },
    };

    addAnnotation(annotation, element);
    return {
      normal: viewPlaneNormal,
      point: viewport.canvasToWorld([100, 100]),
    };
  };

  _getViewportsInfo = () => {
    const viewports = getToolGroup(this.toolGroupId).viewportsInfo;
    return viewports;
  };

  onSetToolInactive() {
    console.debug(
      `VolumeCroppingControlTool: onSetToolInactive called for tool ${this.getToolName()}`
    );
    this._unsubscribeFromCameraModified(this._getViewportsInfo());
  }

  onSetToolActive() {
    const viewportsInfo = this._getViewportsInfo();

    // Check if any annotation exists before proceeding
    let anyAnnotationExists = false;
    for (const vpInfo of viewportsInfo) {
      const enabledElement = getEnabledElementByIds(
        vpInfo.viewportId,
        vpInfo.renderingEngineId
      );
      const annotations = this._getAnnotations(enabledElement);
      if (annotations && annotations.length > 0) {
        anyAnnotationExists = true;
        break;
      }
    }

    // this._unsubscribeFromCameraModified(viewportsInfo); // Per sicurezza
    this._subscribeToCameraModified(viewportsInfo);

    if (!anyAnnotationExists) {
      this._unsubscribeToViewportNewVolumeSet(viewportsInfo);
      this._subscribeToViewportNewVolumeSet(viewportsInfo);
      // Request the volume cropping tool to send current planes
      this._computeToolCenter(viewportsInfo);
      triggerEvent(eventTarget, Events.VOLUMECROPPINGCONTROL_TOOL_CHANGED, {
        toolGroupId: this.toolGroupId,
        viewportsInfo: viewportsInfo,
        seriesInstanceUID: this.seriesInstanceUID,
      });
    } else {
      // Turn off visibility of existing annotations
      for (const vpInfo of viewportsInfo) {
        const enabledElement = getEnabledElementByIds(
          vpInfo.viewportId,
          vpInfo.renderingEngineId
        );

        if (!enabledElement) {
          continue;
        }

        const annotations = this._getAnnotations(enabledElement);
        if (annotations && annotations.length > 0) {
          annotations.forEach((annotation) => {
            removeAnnotation(annotation.annotationUID);
          });
        }

        // Render after removing annotations to clear reference lines
        enabledElement.viewport.render();
      }
    }
  }

  onSetToolEnabled() {
    // ...
  }

  onSetToolDisabled() {
    console.debug(
      `VolumeCroppingControlTool: onSetToolDisabled called for tool ${this.getToolName()}`
    );
    const viewportsInfo = this._getViewportsInfo();

    this._unsubscribeToViewportNewVolumeSet(viewportsInfo);
    this._unsubscribeFromCameraModified(viewportsInfo);

    // has no value when the tool is disabled
    // since viewports can change (zoom, pan, scroll)
    // between disabled and enabled/active states.
    // so we just remove the annotations from the state
    viewportsInfo.forEach(({ renderingEngineId, viewportId }) => {
      const enabledElement = getEnabledElementByIds(
        viewportId,
        renderingEngineId
      );

      if (!enabledElement) {
        return;
      }

      const annotations = this._getAnnotations(enabledElement);
      if (annotations?.length) {
        annotations.forEach((annotation) => {
          removeAnnotation(annotation.annotationUID);
        });
      }
    });
  }

  resetCroppingSpheres = () => {
    const viewportsInfo = this._getViewportsInfo();
    for (const viewportInfo of viewportsInfo) {
      const { viewportId, renderingEngineId } = viewportInfo;
      const enabledElement = getEnabledElementByIds(
        viewportId,
        renderingEngineId
      );
      const viewport = enabledElement.viewport as Types.IVolumeViewport;
      const resetPan = true;
      const resetZoom = true;
      const resetToCenter = true;
      const resetRotation = true;
      const suppressEvents = true;
      viewport.resetCamera({
        resetPan,
        resetZoom,
        resetToCenter,
        resetRotation,
        suppressEvents,
      });
      (viewport as Types.IVolumeViewport).resetSlabThickness();
      const { element } = viewport;
      let annotations = this._getAnnotations(enabledElement);
      annotations = this.filterInteractableAnnotationsForElement(
        element,
        annotations
      );
      if (annotations.length) {
        removeAnnotation(annotations[0].annotationUID);
      }
      viewport.render();
    }

    this._computeToolCenter(viewportsInfo);
  };

  _computeToolCenter = (viewportsInfo): void => {
    if (!viewportsInfo || !viewportsInfo[0]) {
      console.warn(
        '  _computeToolCenter : No valid viewportsInfo for computeToolCenter.'
      );
      return;
    }
    // Support any missing orientation
    const orientationIds = ['AXIAL', 'CORONAL', 'SAGITTAL'];
    // Get present orientations from viewportsInfo
    const presentOrientations = viewportsInfo
      .map((vp) => {
        if (vp.renderingEngineId) {
          const renderingEngine = getRenderingEngine(vp.renderingEngineId);
          const viewport = renderingEngine.getViewport(vp.viewportId);
          if (viewport && viewport.getCamera) {
            const orientation = this._getOrientationFromNormal(
              viewport.getCamera().viewPlaneNormal
            );
            if (orientation) {
              return orientation;
            }
          }
        }
        return null;
      })
      .filter(Boolean);

    const missingOrientation = orientationIds.find(
      (id) => !presentOrientations.includes(id)
    );

    // Initialize present viewports

    const presentNormals: Types.Point3[] = [];
    const presentCenters: Types.Point3[] = [];
    // Find present viewport infos by matching orientation, not viewportId
    const presentViewportInfos = viewportsInfo.filter((vp) => {
      let orientation = null;
      if (vp.renderingEngineId) {
        const renderingEngine = getRenderingEngine(vp.renderingEngineId);
        const viewport = renderingEngine.getViewport(vp.viewportId);
        if (viewport && viewport.getCamera) {
          orientation = this._getOrientationFromNormal(
            viewport.getCamera().viewPlaneNormal
          );
        }
      }
      return orientation && orientationIds.includes(orientation);
    });
    presentViewportInfos.forEach((vpInfo) => {
      const { normal, point } = this.initializeViewport(vpInfo);
      presentNormals.push(normal);
      presentCenters.push(point);
    });

    if (viewportsInfo && viewportsInfo.length) {
      triggerAnnotationRenderForViewportIds(
        viewportsInfo.map(({ viewportId }) => viewportId)
      );
    }
  };
  /**
   * Utility function to map a camera normal to an orientation string.
   * Returns 'AXIAL', 'CORONAL', 'SAGITTAL', or null if not matched.
   */
  _getOrientationFromNormal(normal: Types.Point3): string | null {
    if (!normal) {
      return null;
    }
    // Canonical normals
    const canonical = {
      AXIAL: [0, 0, 1],
      CORONAL: [0, 1, 0],
      SAGITTAL: [1, 0, 0],
    };
    // Use a tolerance for floating point comparison
    const tol = 1e-2;
    for (const [key, value] of Object.entries(canonical)) {
      if (
        Math.abs(normal[0] - value[0]) < tol &&
        Math.abs(normal[1] - value[1]) < tol &&
        Math.abs(normal[2] - value[2]) < tol
      ) {
        return key;
      }
      // Also check negative direction
      if (
        Math.abs(normal[0] + value[0]) < tol &&
        Math.abs(normal[1] + value[1]) < tol &&
        Math.abs(normal[2] + value[2]) < tol
      ) {
        return key;
      }
    }
    return null;
  }
  _syncWithVolumeCroppingTool(originalClippingPlanes) {
    // Sync our tool centers with the clipping plane bounds
    const planes = originalClippingPlanes;
    if (planes.length >= 6) {
      this.toolCenterMin = [
        planes[0].origin[0], // XMIN
        planes[2].origin[1], // YMIN
        planes[4].origin[2], // ZMIN
      ];
      this.toolCenterMax = [
        planes[1].origin[0], // XMAX
        planes[3].origin[1], // YMAX
        planes[5].origin[2], // ZMAX
      ];
      this.toolCenter = [
        (this.toolCenterMin[0] + this.toolCenterMax[0]) / 2,
        (this.toolCenterMin[1] + this.toolCenterMax[1]) / 2,
        (this.toolCenterMin[2] + this.toolCenterMax[2]) / 2,
      ];

      // Update annotations based on their specific orientation
      const viewportsInfo = this._getViewportsInfo();
      viewportsInfo.forEach(({ viewportId, renderingEngineId }) => {
        const enabledElement = getEnabledElementByIds(
          viewportId,
          renderingEngineId
        );
        if (enabledElement) {
          const annotations = this._getAnnotations(enabledElement);
          annotations.forEach((annotation) => {
            if (
              annotation.data &&
              annotation.data.handles &&
              annotation.data.orientation
            ) {
              const orientation = annotation.data.orientation;

              // Update tool centers based on the specific orientation
              if (orientation === 'AXIAL') {
                // Axial views see X and Y clipping planes
                annotation.data.handles.toolCenterMin = [
                  planes[0].origin[0], // XMIN
                  planes[2].origin[1], // YMIN
                  annotation.data.handles.toolCenterMin[2], // Keep existing Z
                ];
                annotation.data.handles.toolCenterMax = [
                  planes[1].origin[0], // XMAX
                  planes[3].origin[1], // YMAX
                  annotation.data.handles.toolCenterMax[2], // Keep existing Z
                ];
              } else if (orientation === 'CORONAL') {
                // Coronal views see X and Z clipping planes
                annotation.data.handles.toolCenterMin = [
                  planes[0].origin[0], // XMIN
                  annotation.data.handles.toolCenterMin[1], // Keep existing Y
                  planes[4].origin[2], // ZMIN
                ];
                annotation.data.handles.toolCenterMax = [
                  planes[1].origin[0], // XMAX
                  annotation.data.handles.toolCenterMax[1], // Keep existing Y
                  planes[5].origin[2], // ZMAX
                ];
              } else if (orientation === 'SAGITTAL') {
                // Sagittal views see Y and Z clipping planes
                annotation.data.handles.toolCenterMin = [
                  annotation.data.handles.toolCenterMin[0], // Keep existing X
                  planes[2].origin[1], // YMIN
                  planes[4].origin[2], // ZMIN
                ];
                annotation.data.handles.toolCenterMax = [
                  annotation.data.handles.toolCenterMax[0], // Keep existing X
                  planes[3].origin[1], // YMAX
                  planes[5].origin[2], // ZMAX
                ];
              }

              // Update the tool center as midpoint
              annotation.data.handles.toolCenter = [
                (annotation.data.handles.toolCenterMin[0] +
                  annotation.data.handles.toolCenterMax[0]) / 2,
                (annotation.data.handles.toolCenterMin[1] +
                  annotation.data.handles.toolCenterMax[1]) / 2,
                (annotation.data.handles.toolCenterMin[2] +
                  annotation.data.handles.toolCenterMax[2]) / 2,
              ];
            }
          });
        }
      });

      // Trigger re-render to show updated reference lines
      triggerAnnotationRenderForViewportIds(
        viewportsInfo.map(({ viewportId }) => viewportId)
      );
    }
  }

  setToolCenter(toolCenter: Types.Point3, handleType): void {
    if (handleType === 'min') {
      this.toolCenterMin = [...toolCenter];
    } else if (handleType === 'max') {
      this.toolCenterMax = [...toolCenter];
    }
    const viewportsInfo = this._getViewportsInfo();

    // assuming all viewports are in the same rendering engine
    triggerAnnotationRenderForViewportIds(
      viewportsInfo.map(({ viewportId }) => viewportId)
    );
  }

  /**
   * addNewAnnotation is called when the user clicks on the image.
   * It does not store the annotation in the stateManager though.
   *
   * @param evt - The mouse event
   * @param interactionType - The type of interaction (e.g., mouse, touch, etc.)
   * @returns  annotation
   */

  addNewAnnotation(
    evt: EventTypes.InteractionEventType
  ): VolumeCroppingAnnotation {
    const eventDetail = evt.detail;
    const { element } = eventDetail;
    const enabledElement = getEnabledElement(element);
    const { viewport } = enabledElement;
    const annotations = this._getAnnotations(enabledElement);
    const filteredAnnotations = this.filterInteractableAnnotationsForElement(
      viewport.element,
      annotations
    );

    // Guard clause: if no interactable annotation, return null
    if (
      !filteredAnnotations ||
      filteredAnnotations.length === 0 ||
      !filteredAnnotations[0]
    ) {
      return null;
    }

    const { data } = filteredAnnotations[0];

    const viewportIdArray = [];
    // put all the draggable reference lines in the viewportIdArray

    const referenceLines = data.referenceLines || [];
    for (let i = 0; i < referenceLines.length; ++i) {
      const otherViewport = referenceLines[i][0];
      viewportIdArray.push(otherViewport.id);
      i++;
    }

    data.activeViewportIds = [...viewportIdArray];
    // set translation operation
    data.handles.activeOperation = OPERATION.DRAG;

    evt.preventDefault();

    hideElementCursor(element);

    this._activateModify(element);
    return filteredAnnotations[0];
  }

  cancel = () => {
    console.log('Not implemented yet');
  };

  /**
   * It returns if the canvas point is near the provided volume cropping annotation in the
   * provided element or not. A proximity is passed to the function to determine the
   * proximity of the point to the annotation in number of pixels.
   *
   * @param element - HTML Element
   * @param annotation - Annotation
   * @param canvasCoords - Canvas coordinates
   * @param proximity - Proximity to tool to consider
   * @returns Boolean, whether the canvas point is near tool
   */
  isPointNearTool = (
    element: HTMLDivElement,
    annotation: VolumeCroppingAnnotation,
    canvasCoords: Types.Point2,
    proximity: number
  ): boolean => {
    if (this._pointNearTool(element, annotation, canvasCoords, 6)) {
      return true;
    }

    return false;
  };

  toolSelectedCallback = (
    evt: EventTypes.InteractionEventType,
    annotation: Annotation,
    interactionType: InteractionTypes
  ): void => {
    const eventDetail = evt.detail;
    const { element } = eventDetail;
    annotation.highlighted = true;
    this._activateModify(element);

    hideElementCursor(element);

    evt.preventDefault();
  };

  handleSelectedCallback(
    evt: EventTypes.InteractionEventType,
    annotation: Annotation,
    handle: ToolHandle,
    interactionType: InteractionTypes
  ): void {
    // You can customize this logic as needed
    // For now, just call toolSelectedCallback if you want default behavior
    this.toolSelectedCallback(evt, annotation, interactionType);
  }

  onResetCamera = (evt) => {
    this.resetCroppingSpheres();
  };

  mouseMoveCallback = (
    evt: EventTypes.MouseMoveEventType,
    filteredToolAnnotations: Annotations
  ): boolean => {
    if (!filteredToolAnnotations) {
      return;
    }
    const { element, currentPoints } = evt.detail;
    const canvasCoords = currentPoints.canvas;
    let imageNeedsUpdate = false;

    for (let i = 0; i < filteredToolAnnotations.length; i++) {
      const annotation = filteredToolAnnotations[i] as VolumeCroppingAnnotation;

      if (isAnnotationLocked(annotation.annotationUID)) {
        continue;
      }

      const { data, highlighted } = annotation;
      if (!data.handles) {
        continue;
      }

      // This init are necessary, because when we move the mouse they are not cleaned by _endCallback
      data.activeViewportIds = [];
      let near = false;
      near = this._pointNearTool(element, annotation, canvasCoords, 6);

      const nearToolAndNotMarkedActive = near && !highlighted;
      const notNearToolAndMarkedActive = !near && highlighted;
      if (nearToolAndNotMarkedActive || notNearToolAndMarkedActive) {
        annotation.highlighted = !highlighted;
        imageNeedsUpdate = true;
      }
    }

    return imageNeedsUpdate;
  };

  filterInteractableAnnotationsForElement = (element, annotations) => {
    if (!annotations || !annotations.length) {
      return [];
    }

    const enabledElement = getEnabledElement(element);
    // Use orientation property for matching
    let orientation = null;
    if (enabledElement.viewport && enabledElement.viewport.getCamera) {
      orientation = this._getOrientationFromNormal(
        enabledElement.viewport.getCamera().viewPlaneNormal
      );
    }

    // Filter annotations for this orientation
    const filtered = annotations.filter((annotation) => {
      // Match by orientation property
      if (
        annotation.data.orientation &&
        orientation &&
        annotation.data.orientation === orientation
      ) {
        return true;
      }
      return false;
    });

    return filtered;
  };

  /**
   * renders the volume cropping lines and handles in the requestAnimationFrame callback
   *
   * @param enabledElement - The Cornerstone's enabledElement.
   * @param svgDrawingHelper - The svgDrawingHelper providing the context for drawing.
   */
  renderAnnotation = (
    enabledElement: Types.IEnabledElement,
    svgDrawingHelper: SVGDrawingHelper
  ): boolean => {
    const viewportsInfo = this._getViewportsInfo();
    if (!viewportsInfo || viewportsInfo.length === 0) {
      return false;
    }

    let renderStatus = false;
    const { viewport, renderingEngine } = enabledElement;
    const { element } = viewport;
    const annotations = this._getAnnotations(enabledElement);
    const filteredToolAnnotations =
      this.filterInteractableAnnotationsForElement(element, annotations);

    const viewportAnnotation = filteredToolAnnotations[0];
    if (!viewportAnnotation?.data) {
      return renderStatus;
    }

    const { annotationUID, data } = viewportAnnotation;
    const otherViewportAnnotations = annotations.filter(
      (annotation) =>
        annotation.data.viewportId !== viewportAnnotation.data.viewportId
    );

    const referenceLines = calculateReferenceLines(
      viewport,
      this.toolCenterMin,
      this.toolCenterMax,
      otherViewportAnnotations,
      renderingEngine
    );

    data.referenceLines = referenceLines;

    // Draw the overlay
    // Dentro renderAnnotation, dopo il recupero di 'viewportAnnotation' e prima del disegno delle linee...

    // ================= INIZIO NUOVO CODICE OVERLAY =================
    // Controlla se abbiamo un'annotazione valida per la viewport corrente
    if (viewportAnnotation && viewportAnnotation.data) {
      // 1. Proietta i punti Min/Max del box 3D sul canvas 2D
      const canvasMin = viewport.worldToCanvas(this.toolCenterMin);
      const canvasMax = viewport.worldToCanvas(this.toolCenterMax);

      // 2. Trova i bordi del rettangolo sul canvas in modo robusto,
      //    indipendentemente dall'orientamento degli assi.
      const left = Math.min(canvasMin[0], canvasMax[0]);
      const right = Math.max(canvasMin[0], canvasMax[0]);
      const top = Math.min(canvasMin[1], canvasMax[1]);
      const bottom = Math.max(canvasMin[1], canvasMax[1]);

      // 3. Costruisci i quattro vertici del buco
      const holePoints: Types.Point2[] = [
        [left, top],
        [left, bottom],
        [right, bottom],
        [right, top],
      ];

      const { clientWidth, clientHeight } = viewport.canvas;

      // 4. Definisci i punti per il perimetro esterno
      const outerPoints: Types.Point2[] = [
        [0, 0],
        [clientWidth, 0],
        [clientWidth, clientHeight],
        [0, clientHeight],
      ];

      // 5. Chiama la funzione di disegno
      drawPathWithHole(
        svgDrawingHelper,
        annotationUID,
        'cropping-box-overlay',
        outerPoints,
        holePoints,
        {
          fillColor: '#000000',
          fillOpacity: 0.5,
        }
      );
    }
    // ================== FINE CODICE OVERLAY NON CONFIGURABILE ==================

    referenceLines.forEach((line, lineIndex) => {
      const intersections = calculateIntersections(referenceLines, lineIndex);

      const selectedViewportId = data.activeViewportIds.find(
        (id) => id === line[0].id
      );

      let lineWidth = this.configuration.lineWidth ?? 1.5;
      const lineActive =
        data.handles.activeOperation === OPERATION.DRAG && selectedViewportId;

      if (lineActive) {
        lineWidth = this.configuration.activeLineWidth ?? 2.5;
      }

      const lineUID = `${lineIndex}`;
      if (intersections.length === 2) {
        drawLineSvg(
          svgDrawingHelper,
          annotationUID,
          lineUID,
          intersections[0].point,
          intersections[1].point,
          {
            color: REFERENCE_LINE_COLOR,
            lineWidth,
            lineDash: this.mode === 'Active' ? [4, 4] : undefined,
          }
        );
      }
    });

    renderStatus = true;
    return renderStatus;
  };

  _getAnnotations = (enabledElement: Types.IEnabledElement) => {
    const { viewport } = enabledElement;
    const annotations =
      getAnnotations(this.getToolName(), viewport.element) || [];
    const viewportIds = this._getViewportsInfo().map(
      ({ viewportId }) => viewportId
    );

    // filter the annotations to only keep that are for this toolGroup
    const toolGroupAnnotations = annotations.filter((annotation) => {
      const { data } = annotation;
      return viewportIds.includes(data.viewportId);
    });

    return toolGroupAnnotations;
  };

  _onNewVolume = () => {
    const viewportsInfo = this._getViewportsInfo();
    if (viewportsInfo && viewportsInfo.length > 0) {
      const { viewportId, renderingEngineId } = viewportsInfo[0];
      const renderingEngine = getRenderingEngine(renderingEngineId);
      const viewport = renderingEngine.getViewport(viewportId);
      const volumeActors = viewport.getActors();
      if (volumeActors.length > 0) {
        const imageData = volumeActors[0].actor.getMapper().getInputData();
        if (imageData) {
          this.seriesInstanceUID = imageData.seriesInstanceUID;
          this._updateToolCentersFromViewport(viewport);
          // Update all annotations' handles.toolCenter
          const annotations =
            getAnnotations(this.getToolName(), viewportId) || [];
          annotations.forEach((annotation) => {
            if (annotation.data && annotation.data.handles) {
              annotation.data.handles.toolCenter = [...this.toolCenter];
            }
          });
        }
      }
    }
    this._computeToolCenter(viewportsInfo);
    triggerEvent(eventTarget, Events.VOLUMECROPPINGCONTROL_TOOL_CHANGED, {
      toolGroupId: this.toolGroupId,
      viewportsInfo: viewportsInfo,
      seriesInstanceUID: this.seriesInstanceUID,
    });
  };

  _handleCameraModified = (evt: Types.EventTypes.CameraModifiedEvent) => {
    // Non fare nulla se stiamo già interagendo attivamente con il tool
    if (state.isInteractingWithTool) {
      return;
    }

    const viewportsInfo = this._getViewportsInfo();
    let isAnyViewportRotated = false;

    for (const { renderingEngineId, viewportId } of viewportsInfo) {
      const enabledElement = getEnabledElementByIds(
        viewportId,
        renderingEngineId
      );

      if (enabledElement) {
        const { viewport } = enabledElement;
        const orientation = this._getOrientationFromNormal(
          viewport.getCamera().viewPlaneNormal
        );

        // Se l'orientamento è null, la vista è ruotata/obliqua
        if (orientation === null) {
          isAnyViewportRotated = true;
          break; // Trovata una vista ruotata, non serve controllare le altre
        }
      }
    }

    const toolGroup = getToolGroup(this.toolGroupId);
    if (!toolGroup) {
      return;
    }

    console.log('MODE', this.mode)

    // Se una viewport è ruotata e il tool è attualmente abilitato, disabilitalo.
    if (isAnyViewportRotated && this.mode === 'Active') {
      console.warn('Una viewport è stata ruotata. Disabilitazione del VolumeCroppingControlTool.');
      toolGroup.setToolEnabled(this.getToolName());
    }
    // Opzionale: riabilita il tool se nessuna viewport è più ruotata
    else if (!isAnyViewportRotated && this.mode === 'Enabled') {
      console.log('Tutte le viewport sono tornate a una vista canonica. Riabilitazione del VolumeCroppingControlTool.');
      toolGroup.setToolActive(this.getToolName());
    }
  };

  _subscribeToCameraModified(viewports) {
    viewports.forEach(({ viewportId, renderingEngineId }) => {
      console.log('Subscribing to CAMERA_MODIFIED for viewport', viewportId, renderingEngineId);
      const { viewport } = getEnabledElementByIds(
        viewportId,
        renderingEngineId
      );
      viewport.element.addEventListener(
        Enums.Events.CAMERA_MODIFIED,
        this._handleCameraModified
      );
    });
  }

  _unsubscribeFromCameraModified(viewports) {
    viewports.forEach(({ viewportId, renderingEngineId }) => {
      const { viewport } = getEnabledElementByIds(
        viewportId,
        renderingEngineId
      );
      viewport.element.removeEventListener(
        Enums.Events.CAMERA_MODIFIED,
        this._handleCameraModified
      );
    });
  }

  _unsubscribeToViewportNewVolumeSet(viewportsInfo) {
    viewportsInfo.forEach(({ viewportId, renderingEngineId }) => {
      const { viewport } = getEnabledElementByIds(
        viewportId,
        renderingEngineId
      );
      const { element } = viewport;

      element.removeEventListener(
        Enums.Events.VOLUME_VIEWPORT_NEW_VOLUME,
        this._onNewVolume
      );
    });
  }

  _subscribeToViewportNewVolumeSet(viewports) {
    viewports.forEach(({ viewportId, renderingEngineId }) => {
      const { viewport } = getEnabledElementByIds(
        viewportId,
        renderingEngineId
      );
      const { element } = viewport;

      element.addEventListener(
        Enums.Events.VOLUME_VIEWPORT_NEW_VOLUME,
        this._onNewVolume
      );
    });
  }

  _activateModify = (element) => {
    element.addEventListener(Events.MOUSE_UP, this._endCallback);
    element.addEventListener(Events.MOUSE_DRAG, this._dragCallback);
    element.addEventListener(Events.MOUSE_CLICK, this._endCallback);

    element.addEventListener(Events.TOUCH_END, this._endCallback);
    element.addEventListener(Events.TOUCH_DRAG, this._dragCallback);
    element.addEventListener(Events.TOUCH_TAP, this._endCallback);
  };

  _deactivateModify = (element) => {
    state.isInteractingWithTool = false;

    element.removeEventListener(Events.MOUSE_UP, this._endCallback);
    element.removeEventListener(Events.MOUSE_DRAG, this._dragCallback);
    element.removeEventListener(Events.MOUSE_CLICK, this._endCallback);

    element.removeEventListener(Events.TOUCH_END, this._endCallback);
    element.removeEventListener(Events.TOUCH_DRAG, this._dragCallback);
    element.removeEventListener(Events.TOUCH_TAP, this._endCallback);
  };

  _endCallback = (evt: EventTypes.InteractionEventType) => {
    const eventDetail = evt.detail;
    const { element } = eventDetail;

    this.editData.annotation.data.handles.activeOperation = null;
    this.editData.annotation.data.activeViewportIds = [];

    this._deactivateModify(element);

    resetElementCursor(element);

    this.editData = null;

    const requireSameOrientation = false;
    const viewportIdsToRender = getViewportIdsWithToolToRender(
      element,
      this.getToolName(),
      requireSameOrientation
    );

    triggerAnnotationRenderForViewportIds(viewportIdsToRender);
  };

  _dragCallback = (evt: EventTypes.InteractionEventType) => {
    const eventDetail = evt.detail;
    const delta = eventDetail.deltaPoints.world;

    if (
      Math.abs(delta[0]) < 1e-3 &&
      Math.abs(delta[1]) < 1e-3 &&
      Math.abs(delta[2]) < 1e-3
    ) {
      return;
    }

    const { element } = eventDetail;
    const enabledElement = getEnabledElement(element);
    const { viewport } = enabledElement;
    if (viewport.type === Enums.ViewportType.VOLUME_3D) {
      return;
    }
    const annotations = this._getAnnotations(
      enabledElement
    ) as VolumeCroppingAnnotation[];
    const filteredToolAnnotations =
      this.filterInteractableAnnotationsForElement(element, annotations);

    const viewportAnnotation = filteredToolAnnotations[0];
    if (!viewportAnnotation) {
      return;
    }

    const { handles } = viewportAnnotation.data;

    if (handles.activeOperation === OPERATION.DRAG) {
      const activeType = handles.activeType; // 'min' o 'max'
      const axisName = handles.activeAxisName; // 'X', 'Y', or 'Z'

      // Applica il delta solo sull'asse corretto
      if (activeType === 'min' || activeType === 'max') {
        let axis = -1;
        if (axisName === 'X') {
          axis = 0;
        } else if (axisName === 'Y') {
          axis = 1;
        } else if (axisName === 'Z') {
          axis = 2;
        }

        if (axis !== -1) {
          if (activeType === 'min') {
            this.toolCenterMin[axis] += delta[axis];
          } else {
            this.toolCenterMax[axis] += delta[axis];
          }
        }
      } else {
        // Se trascini il centro, aggiorna tutti gli assi
        this.toolCenter[0] += delta[0];
        this.toolCenter[1] += delta[1];
        this.toolCenter[2] += delta[2];
      }

      const viewportsInfo = this._getViewportsInfo();
      triggerAnnotationRenderForViewportIds(
        viewportsInfo.map(({ viewportId }) => viewportId)
      );
      triggerEvent(eventTarget, Events.VOLUMECROPPINGCONTROL_TOOL_CHANGED, {
        toolGroupId: this.toolGroupId,
        toolCenter: this.toolCenter,
        toolCenterMin: this.toolCenterMin,
        toolCenterMax: this.toolCenterMax,
        handleType: handles.activeType,
        viewportOrientation: [],
        seriesInstanceUID: this.seriesInstanceUID,
      });
    }
  };

  _applyDeltaShiftToSelectedViewportCameras(
    renderingEngine,
    viewportsAnnotationsToUpdate,
    delta
  ) {
    // update camera for the other viewports.
    // NOTE1: The lines then are rendered by the onCameraModified
    viewportsAnnotationsToUpdate.forEach((annotation) => {
      this._applyDeltaShiftToViewportCamera(renderingEngine, annotation, delta);
    });
  }

  _applyDeltaShiftToViewportCamera(
    renderingEngine: Types.IRenderingEngine,
    annotation,
    delta
  ) {
    const { data } = annotation;

    const viewport = renderingEngine.getViewport(data.viewportId);
    const camera = viewport.getCamera();
    const normal = camera.viewPlaneNormal;

    // Project delta over camera normal
    // (we don't need to pan, we need only to scroll the camera as in the wheel stack scroll tool)
    const dotProd = vtkMath.dot(delta, normal);
    const projectedDelta: Types.Point3 = [...normal];
    vtkMath.multiplyScalar(projectedDelta, dotProd);

    if (
      Math.abs(projectedDelta[0]) > 1e-3 ||
      Math.abs(projectedDelta[1]) > 1e-3 ||
      Math.abs(projectedDelta[2]) > 1e-3
    ) {
      const newFocalPoint: Types.Point3 = [0, 0, 0];
      const newPosition: Types.Point3 = [0, 0, 0];

      vtkMath.add(camera.focalPoint, projectedDelta, newFocalPoint);
      vtkMath.add(camera.position, projectedDelta, newPosition);

      viewport.setCamera({
        focalPoint: newFocalPoint,
        position: newPosition,
      });
      viewport.render();
    }
  }

  _pointNearTool(element, annotation, canvasCoords, proximity) {
    const { data } = annotation;

    const referenceLines = data.referenceLines;
    const viewportIdArray = [];

    let isNear = false;

    if (referenceLines) {
      for (let i = 0; i < referenceLines.length; ++i) {
        const otherViewport = referenceLines[i][0];
        const start1 = referenceLines[i][1];
        const end1 = referenceLines[i][2];
        const type = referenceLines[i][3]; // 'min' or 'max'
        const axisIndex = referenceLines[i][4]; // 0 o 1
        const axisName = referenceLines[i][5]; // 'X', 'Y', or 'Z'

        const distance1 = lineSegment.distanceToPoint(start1, end1, [
          canvasCoords[0],
          canvasCoords[1],
        ]);

        if (distance1 <= proximity) {
          viewportIdArray.push(otherViewport.id);
          data.handles.activeOperation = 1; // DRAG
          data.handles.activeType = type;
          data.handles.activeLineIndex = axisIndex;
          data.handles.activeAxisName = axisName; // Aggiungi il nome dell'asse
          isNear = true;
        }
      }
    }

    data.activeViewportIds = [...viewportIdArray];

    this.editData = {
      annotation,
    };
    return isNear;
  }
}

VolumeCroppingControlTool.toolName = 'VolumeCroppingControl';
export default VolumeCroppingControlTool;
