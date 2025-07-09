import { vec2, vec3 } from 'gl-matrix';
import type { Types } from '@cornerstonejs/core';
import {
  getEnabledElement,
  getRenderingEngine,
  getEnabledElementByIds,
  utilities as csUtils,
  Enums,
  CONSTANTS,
} from '@cornerstonejs/core';
import {
  getAnnotations,
  addAnnotation,
  removeAnnotation,
} from '../stateManagement/annotation/annotationState';
import { state } from '../store/state';

import { AnnotationTool } from './base';
import { getToolGroup, getToolGroupForViewport } from '../store/ToolGroupManager';
import { drawCircle as drawCircleSvg, drawLine as drawLineSvg } from '../drawingSvg';
import type { SVGDrawingHelper, Annotation, EventTypes, InteractionTypes } from '../types';
import liangBarksyClip from '../utilities/math/vec2/liangBarksyClip';
import * as lineSegment from '../utilities/math/line';
import { Events } from '../enums';
import { getViewportIdsWithToolToRender } from '../utilities/viewportFilters';
import vtkMath from '@kitware/vtk.js/Common/Core/Math';
const { RENDERING_DEFAULTS } = CONSTANTS;
import triggerAnnotationRenderForViewportIds from '../utilities/triggerAnnotationRenderForViewportIds';
import {
  resetElementCursor,
  hideElementCursor,
} from '../cursors/elementCursor';

const OPERATION = {
  DRAG: 1,
  ROTATE: 2,
  SLAB: 3,
};

/**
 * This tool renders intersection lines between a source viewport and other viewports.
 * It listens to camera modifications in the source viewport and updates the intersection lines accordingly.
 *
 * // TODO
 * - Add support for dragging lines to adjust the slab
 * - Visualize center of the slab (center plane) [nice to have]
 * - Add support for rotating the plane [nice to have]
 *
 * // FIXME
 * - The tool currently does not remove annotations when disabled. FIx the bug in removeAnnotations method.
 */


class IntersectionLinesTool extends AnnotationTool {
  static toolName = 'IntersectionLinesTool';
  toolCenter: Types.Point3 = [0, 0, 0];

  constructor(
    toolProps = {},
    defaultToolProps = {
      supportedInteractionTypes: [], // No interaction
      configuration: {
        sourceViewportId: null,
        color: 'rgb(255, 255, 0)',
        lineWidth: 1,
      },
    }
  ) {
    super(toolProps, defaultToolProps);

    this._renderAllViewports = this._renderAllViewports.bind(this);
  }

  onSetToolEnabled = (): void => {
    this._init();
    this._initListener();
  };

  onSetToolActive = (): void => {
    this._init();
    this._initListener();
  };

  onSetToolPassive = (): void => {
    this._init();
    this._initListener();
  };

  onSetToolDisabled = (): void => {
    // this._removeAnnotations(); // TODO fix this
    this._removeListener();
  };

  _init() {
    const toolGroup = getToolGroup(this.toolGroupId);
    if (!toolGroup) {
      return;
    }
    const viewports = toolGroup.viewportsInfo;

    viewports.forEach(({ renderingEngineId, viewportId }) => {
      const enabledElement = getEnabledElementByIds(
        viewportId,
        renderingEngineId
      );

      if (!enabledElement) {
        console.warn(
          `Enabled element not found for viewport ${viewportId} in rendering engine ${renderingEngineId}`
        );
        return;
      }

      // const { element } = enabledElement;
      const element = document.getElementById(viewportId) as HTMLDivElement;

      let annotations = getAnnotations(this.getToolName(), element);
      annotations = this.filterInteractableAnnotationsForElement(
        element,
        annotations
      );

      if (annotations.length) {
        return;
      }

      const annotation: Annotation = {
        highlighted: false,
        isLocked: true,
        metadata: {
          toolName: this.getToolName(),
          FrameOfReferenceUID: enabledElement.FrameOfReferenceUID,
          referencedImageId: '',
        },
        data: {
          viewportId: this.configuration.sourceViewportId,
          handles: {
            rotationPoints: [], // rotation handles, used for rotation interactions
            slabThicknessPoints: [], // slab thickness handles, used for setting the slab thickness
            toolCenter: this.toolCenter,
          },
          activeOperation: null, // null or 2 slab thickness handles
          activeViewportIds: [], // a list of the viewport ids connected to the reference lines being translated
        },
      };
      addAnnotation(annotation, element);
    });
  }

  _initListener() {
    const sourceViewportId = this.configuration.sourceViewportId;
    if (!sourceViewportId) {
      console.warn(`Source viewport id is not set for tool ${this.getToolName()}`);
      return;
    }

    const element = document.getElementById(sourceViewportId) as HTMLDivElement;
    element.addEventListener(
      Enums.Events.CAMERA_MODIFIED,
      this._renderAllViewports
    );
  }

  _removeListener() {
    const sourceViewportId = this.configuration.sourceViewportId;
    if (!sourceViewportId) {
      console.warn(`Source viewport id is not set for tool ${this.getToolName()}`);
      return;
    }

    const element = document.getElementById(sourceViewportId) as HTMLDivElement;
    element.removeEventListener(
      Enums.Events.CAMERA_MODIFIED,
      this._renderAllViewports
    );
  }

  _renderAllViewports() {
    const toolGroup = getToolGroup(this.toolGroupId);
    if (!toolGroup) {
      return;
    }
    const viewports = toolGroup.viewportsInfo;
    viewports.forEach(({ renderingEngineId, viewportId }) => {
      const renderingEngine = getRenderingEngine(renderingEngineId);
      const viewport = renderingEngine.getViewport(viewportId);
      if (!viewport) {
        console.warn(`Viewport not found for id ${viewportId}`);
        return;
      }
      viewport.render();
    });
  }

  _removeAnnotations() {
    const toolGroup = getToolGroup(this.toolGroupId);
    if (!toolGroup) {
      return;
    }
    const viewports = toolGroup.viewportsInfo;
    viewports.forEach(({ renderingEngineId, viewportId }) => {
      const enabledElement = getEnabledElementByIds(
        viewportId,
        renderingEngineId
      );
      const { element } = enabledElement;
      const annotations = getAnnotations(this.getToolName(), element);
      if (annotations && annotations.length) {
        annotations.forEach((annotation) =>
          removeAnnotation(annotation.annotationUID)
        );
      }
    });
  }

  _areViewportIdArraysEqual = (viewportIdArrayOne, viewportIdArrayTwo) => {
    if (viewportIdArrayOne.length !== viewportIdArrayTwo.length) {
      return false;
    }

    viewportIdArrayOne.forEach((id) => {
      let itemFound = false;
      for (let i = 0; i < viewportIdArrayTwo.length; ++i) {
        if (id === viewportIdArrayTwo[i]) {
          itemFound = true;
          break;
        }
      }
      if (itemFound === false) {
        return false;
      }
    });

    return true;
  };

  mouseMoveCallback = (
    evt: EventTypes.MouseMoveEventType,
    filteredToolAnnotations: Annotation[]
  ): boolean => {
    const { element, currentPoints } = evt.detail;
    const canvasCoords = currentPoints.canvas;
    let imageNeedsUpdate = false;

    if (!filteredToolAnnotations || !filteredToolAnnotations.length) {
      return imageNeedsUpdate;
    }

    for (let i = 0; i < filteredToolAnnotations.length; i++) {
      const annotation = filteredToolAnnotations[i] as Annotation;

      const { data, highlighted } = annotation;
      if (!data.handles) {
        continue;
      }

      const previousActiveOperation = data.handles.activeOperation;
      const previousActiveViewportIds =
        data.activeViewportIds && data.activeViewportIds.length > 0
          ? [...data.activeViewportIds]
          : [];
      const previousHighlighted = annotation.highlighted;

      // This init are necessary, because when we move the mouse they are not cleaned by _endCallback
      data.activeViewportIds = [];
      data.handles.activeOperation = null;

      let near = false;

      near = this.isPointNearTool(element, annotation, canvasCoords, 6);

      if (near && !previousHighlighted) {
        annotation.highlighted = true;
        imageNeedsUpdate = true;
        data.handles.activeOperation = OPERATION.SLAB;
      }
      else if (!near && previousHighlighted) {
        annotation.highlighted = false;
        imageNeedsUpdate = true;
      }
    }

    return imageNeedsUpdate;
  };


  _pointNearTool(element, annotation, canvasCoords, proximity) {
    const enabledElement = getEnabledElement(element);
    const { viewport } = enabledElement;
    const { clientWidth, clientHeight } = viewport.canvas;
    const canvasDiagonalLength = Math.sqrt(
      clientWidth * clientWidth + clientHeight * clientHeight
    );
    const { data } = annotation;

    const { slabThicknessPoints } = data.handles;
    const viewportIdArray = [];

    for (let i = 0; i < slabThicknessPoints.length - 1; ++i) {
      // const otherViewport = slabThicknessPoints[i][1];
      // if (viewportIdArray.find((id) => id === otherViewport.id)) {
      //   continue;
      // }

      const viewportControllable = true
      const viewportSlabThicknessControlsOn = true
      if (!viewportControllable || !viewportSlabThicknessControlsOn) {
        continue;
      }

      // const stPointLineCanvas1 = slabThicknessPoints[i][2];
      // const stPointLineCanvas2 = slabThicknessPoints[i][3];

      const stPointLineCanvas1 = slabThicknessPoints[i][0];
      const stPointLineCanvas2 = slabThicknessPoints[i][1];
      const centerCanvas = vec2.create();

      // console.log(stPointLineCanvas1, stPointLineCanvas2, centerCanvas)

      if (!stPointLineCanvas1 || !stPointLineCanvas2) {
        continue;
      }

      vec2.add(centerCanvas, stPointLineCanvas1, stPointLineCanvas2);
      vec2.scale(centerCanvas, centerCanvas, 0.5);

      const canvasUnitVectorFromCenter = vec2.create();
      vec2.subtract(
        canvasUnitVectorFromCenter,
        stPointLineCanvas1,
        centerCanvas
      );
      vec2.normalize(canvasUnitVectorFromCenter, canvasUnitVectorFromCenter);

      const canvasVectorFromCenterStart = vec2.create();
      vec2.scale(
        canvasVectorFromCenterStart,
        canvasUnitVectorFromCenter,
        canvasDiagonalLength * 0.05
      );

      const stPointLineCanvas1Start = vec2.create();
      const stPointLineCanvas2Start = vec2.create();
      vec2.add(
        stPointLineCanvas1Start,
        centerCanvas,
        canvasVectorFromCenterStart
      );
      vec2.subtract(
        stPointLineCanvas2Start,
        centerCanvas,
        canvasVectorFromCenterStart
      );

      const lineSegment1 = {
        start: {
          x: stPointLineCanvas1Start[0],
          y: stPointLineCanvas1Start[1],
        },
        end: {
          x: stPointLineCanvas1[0],
          y: stPointLineCanvas1[1],
        },
      };

      const distanceToPoint1 = lineSegment.distanceToPoint(
        [lineSegment1.start.x, lineSegment1.start.y],
        [lineSegment1.end.x, lineSegment1.end.y],
        [canvasCoords[0], canvasCoords[1]]
      );

      const lineSegment2 = {
        start: {
          x: stPointLineCanvas2Start[0],
          y: stPointLineCanvas2Start[1],
        },
        end: {
          x: stPointLineCanvas2[0],
          y: stPointLineCanvas2[1],
        },
      };

      const distanceToPoint2 = lineSegment.distanceToPoint(
        [lineSegment2.start.x, lineSegment2.start.y],
        [lineSegment2.end.x, lineSegment2.end.y],
        [canvasCoords[0], canvasCoords[1]]
      );

      // console.log('distances', distanceToPoint1, distanceToPoint2)

      if (distanceToPoint1 <= proximity || distanceToPoint2 <= proximity) {
        // viewportIdArray.push(otherViewport.id); // we still need this to draw inactive slab thickness handles
        data.handles.activeOperation = OPERATION.SLAB; // no operation
        return true
      }

      // slab thickness handles are in couples
      i++;
    }

    data.activeViewportIds = [...viewportIdArray];

    this.editData = {
      annotation,
    };

    return data.handles.activeOperation === OPERATION.SLAB ? true : false;
  }

  addNewAnnotation(evt: EventTypes.InteractionEventType, interactionType: InteractionTypes): Annotation {
    const eventDetail = evt.detail;
    const { element } = eventDetail;

    const enabledElement = getEnabledElement(element);
    const { viewport } = enabledElement;

    const annotations = this._getAnnotations(enabledElement);
    const filteredAnnotations = this.filterInteractableAnnotationsForElement(
      viewport.element,
      annotations
    );

    // viewport Annotation
    const { data } = filteredAnnotations[0];

    data.handles.activeOperation = OPERATION.SLAB;

    this._activateModify(element);
    return filteredAnnotations[0];
  }

  /**
   * It returns if the canvas point is near the provided crosshairs annotation in the
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
    annotation: Annotation,
    canvasCoords: Types.Point2,
    proximity: number
  ): boolean => {
    if (this._pointNearTool(element, annotation, canvasCoords, proximity)) {
      return true;
    }

    return false;
  };

  _isClockWise(a, b, c) {
    // return true if the rotation is clockwise
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 0;
  }

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

  _activateModify = (element) => {
    // mobile sometimes has lingering interaction even when touchEnd triggers
    // this check allows for multiple handles to be active which doesn't affect
    // tool usage.
    state.isInteractingWithTool = !this.configuration.mobile?.enabled;

    element.addEventListener(Events.MOUSE_UP, this._endCallback);
    element.addEventListener(Events.MOUSE_DRAG, this._dragCallback);
    element.addEventListener(Events.MOUSE_CLICK, this._endCallback);
  };

  _deactivateModify = (element) => {
    state.isInteractingWithTool = false;

    element.removeEventListener(Events.MOUSE_UP, this._endCallback);
    element.removeEventListener(Events.MOUSE_DRAG, this._dragCallback);
    element.removeEventListener(Events.MOUSE_CLICK, this._endCallback);
  };

  _getViewportsInfo = () => {
    const viewports = getToolGroup(this.toolGroupId).viewportsInfo;

    return viewports;
  };

  _getAnnotations = (enabledElement: Types.IEnabledElement) => {
    const { viewport } = enabledElement;
    const annotations =
      getAnnotations(this.getToolName(), viewport.element) || [];

      /*
    const viewportIds = this._getViewportsInfo().map(
      ({ viewportId }) => viewportId
    );

    // filter the annotations to only keep that are for this toolGroup
    const toolGroupAnnotations = annotations.filter((annotation) => {
      const { data } = annotation;
      return viewportIds.includes(data.viewportId);
    });
    */

    const toolGroupAnnotations = annotations

    return toolGroupAnnotations;
  };

  _filterViewportWithSameOrientation = (
    enabledElement,
    referenceAnnotation,
    annotations
  ) => {
    const { renderingEngine } = enabledElement;
    const { data } = referenceAnnotation;
    const viewport = renderingEngine.getViewport(data.viewportId);

    const linkedViewportAnnotations = annotations.filter((annotation) => {
      const { data } = annotation;
      const otherViewport = renderingEngine.getViewport(data.viewportId);
      const otherViewportControllable = true

      return otherViewportControllable === true;
    });

    if (!linkedViewportAnnotations || !linkedViewportAnnotations.length) {
      return [];
    }

    const camera = viewport.getCamera();
    const viewPlaneNormal = camera.viewPlaneNormal;
    vtkMath.normalize(viewPlaneNormal);

    const otherViewportsAnnotationsWithSameCameraDirection =
      linkedViewportAnnotations.filter((annotation) => {
        const { viewportId } = annotation.data;
        const otherViewport = renderingEngine.getViewport(viewportId);
        const otherCamera = otherViewport.getCamera();
        const otherViewPlaneNormal = otherCamera.viewPlaneNormal;
        vtkMath.normalize(otherViewPlaneNormal);

        return (
          csUtils.isEqual(viewPlaneNormal, otherViewPlaneNormal, 1e-2) &&
          csUtils.isEqual(camera.viewUp, otherCamera.viewUp, 1e-2)
        );
      });

    return otherViewportsAnnotationsWithSameCameraDirection;
  };

  _dragCallback = (evt: EventTypes.InteractionEventType) => {
    console.log('dragCallback', evt.detail);
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
    const { renderingEngine, viewport } = enabledElement;
    const annotations = this._getAnnotations(
      enabledElement
    ) as Annotation[];
    const filteredToolAnnotations =
      this.filterInteractableAnnotationsForElement(element, annotations);

    // viewport Annotation
    const viewportAnnotation = filteredToolAnnotations[0];
    if (!viewportAnnotation) {
      return;
    }

    const { handles } = viewportAnnotation.data;
    const { currentPoints } = evt.detail;
    const canvasCoords = currentPoints.canvas;

    if (handles.activeOperation === OPERATION.SLAB) {
/*
      const otherViewportAnnotations =
        this._getAnnotationsForViewportsWithDifferentCameras(
          enabledElement,
          annotations
        );
        */

      const referenceAnnotations = annotations;

      console.log('referenceAnnotations', referenceAnnotations)

      if (referenceAnnotations.length === 0) {
        return;
      }
      const viewportsAnnotationsToUpdate =
        this._filterViewportWithSameOrientation(
          enabledElement,
          referenceAnnotations[0],
          annotations
        );

        console.log('viewportsAnnotationsToUpdate', viewportsAnnotationsToUpdate)

      const viewportsIds = [];
      viewportsIds.push(viewport.id);
      viewportsAnnotationsToUpdate.forEach(
        (annotation: Annotation) => {
          const { data } = annotation;

          const otherViewport = renderingEngine.getViewport(
            data.viewportId
          ) as Types.IVolumeViewport;
          const camera = otherViewport.getCamera();
          const normal = camera.viewPlaneNormal;

          const dotProd = vtkMath.dot(delta, normal);
          const projectedDelta: Types.Point3 = [...normal];
          vtkMath.multiplyScalar(projectedDelta, dotProd);

          if (
            Math.abs(projectedDelta[0]) > 1e-3 ||
            Math.abs(projectedDelta[1]) > 1e-3 ||
            Math.abs(projectedDelta[2]) > 1e-3
          ) {
            const mod = Math.sqrt(
              projectedDelta[0] * projectedDelta[0] +
              projectedDelta[1] * projectedDelta[1] +
              projectedDelta[2] * projectedDelta[2]
            );

            const currentPoint = eventDetail.lastPoints.world;
            const direction: Types.Point3 = [0, 0, 0];

            const currentCenter: Types.Point3 = [
              this.toolCenter[0],
              this.toolCenter[1],
              this.toolCenter[2],
            ];

            console.log('currentCenter', currentCenter);

            // use this.toolCenter only if viewportDraggableRotatable
            const viewportDraggableRotatable = true
            if (!viewportDraggableRotatable) {
              const { rotationPoints } = this.editData.annotation.data.handles;
              // Todo: what is a point uid?
              // @ts-expect-error
              const otherViewportRotationPoints = rotationPoints.filter(
                (point) => point[1].uid === otherViewport.id
              );
              if (otherViewportRotationPoints.length === 2) {
                const point1 = viewport.canvasToWorld(
                  otherViewportRotationPoints[0][3]
                );
                const point2 = viewport.canvasToWorld(
                  otherViewportRotationPoints[1][3]
                );
                vtkMath.add(point1, point2, currentCenter);
                vtkMath.multiplyScalar(<Types.Point3>currentCenter, 0.5);
              }
            }

            vtkMath.subtract(currentPoint, currentCenter, direction);
            const dotProdDirection = vtkMath.dot(direction, normal);
            const projectedDirection: Types.Point3 = [...normal];
            vtkMath.multiplyScalar(projectedDirection, dotProdDirection);
            const normalizedProjectedDirection: Types.Point3 = [
              projectedDirection[0],
              projectedDirection[1],
              projectedDirection[2],
            ];
            vec3.normalize(
              normalizedProjectedDirection,
              normalizedProjectedDirection
            );
            const normalizedProjectedDelta: Types.Point3 = [
              projectedDelta[0],
              projectedDelta[1],
              projectedDelta[2],
            ];
            vec3.normalize(normalizedProjectedDelta, normalizedProjectedDelta);

            let slabThicknessValue = otherViewport.getSlabThickness();
            if (
              csUtils.isOpposite(
                normalizedProjectedDirection,
                normalizedProjectedDelta,
                1e-3
              )
            ) {
              slabThicknessValue -= mod;
            } else {
              slabThicknessValue += mod;
            }

            slabThicknessValue = Math.abs(slabThicknessValue);
            slabThicknessValue = Math.max(
              RENDERING_DEFAULTS.MINIMUM_SLAB_THICKNESS,
              slabThicknessValue
            );

            const near = this._pointNearReferenceLine(
              viewportAnnotation,
              canvasCoords,
              6,
              otherViewport
            );

            console.log(
              'slabThicknessValue',
              slabThicknessValue,
              'near',
              near
            );

            if (near) {
              slabThicknessValue = RENDERING_DEFAULTS.MINIMUM_SLAB_THICKNESS;
            }

            // We want to set the slabThickness for the viewport's actors but
            // since the crosshairs tool instance has configuration regarding which
            // actorUIDs (in case of volume -> actorUID = volumeIds) to set the
            // slabThickness for, we need to delegate the slabThickness setting
            // to the crosshairs tool instance of the toolGroup since configurations
            // exist on the toolInstance and each toolGroup has its own crosshairs
            // tool instance (Otherwise, we would need to set this filterActorUIDsToSetSlabThickness at
            // the viewport level which makes tool and viewport state convoluted).
            /*
            const toolGroup = getToolGroupForViewport(
              otherViewport.id,
              renderingEngine.id
            );
            const crosshairsInstance = toolGroup.getToolInstance(
              this.getToolName()
            );
            crosshairsInstance.setSlabThickness(
              otherViewport,
              slabThicknessValue
            );
            */

            const renderingEngine = getRenderingEngine(
              eventDetail.renderingEngineId
            );
            const viewport = renderingEngine.getViewport(
              'main'
            ) as Types.IVolumeViewport;

            viewport.setSlabThickness(slabThicknessValue);

            console.log('setSlabThickness', otherViewport.id, slabThicknessValue);

            viewportsIds.push(otherViewport.id);
          }
        }
      );
      renderingEngine.render();
    }
  };

  _pointNearReferenceLine = (
    annotation,
    canvasCoords,
    proximity,
    lineViewport
  ) => {
    const { data } = annotation;
    const { rotationPoints } = data.handles;

    for (let i = 0; i < rotationPoints.length - 1; ++i) {
      const otherViewport = rotationPoints[i][1];
      if (otherViewport.id !== lineViewport.id) {
        continue;
      }

      const viewportControllable = true
      if (!viewportControllable) {
        continue;
      }

      const lineSegment1 = {
        start: {
          x: rotationPoints[i][2][0],
          y: rotationPoints[i][2][1],
        },
        end: {
          x: rotationPoints[i][3][0],
          y: rotationPoints[i][3][1],
        },
      };

      const distanceToPoint1 = lineSegment.distanceToPoint(
        [lineSegment1.start.x, lineSegment1.start.y],
        [lineSegment1.end.x, lineSegment1.end.y],
        [canvasCoords[0], canvasCoords[1]]
      );

      const lineSegment2 = {
        start: {
          x: rotationPoints[i + 1][2][0],
          y: rotationPoints[i + 1][2][1],
        },
        end: {
          x: rotationPoints[i + 1][3][0],
          y: rotationPoints[i + 1][3][1],
        },
      };

      const distanceToPoint2 = lineSegment.distanceToPoint(
        [lineSegment2.start.x, lineSegment2.start.y],
        [lineSegment2.end.x, lineSegment2.end.y],
        [canvasCoords[0], canvasCoords[1]]
      );

      if (distanceToPoint1 <= proximity || distanceToPoint2 <= proximity) {
        return true;
      }

      // rotation handles are two for viewport
      i++;
    }

    return false;
  };

  _applyDeltaShiftToSelectedViewportCameras(
    renderingEngine,
    viewportsAnnotationsToUpdate,
    delta
  ) {
    // update camera for the other viewports.
    // NOTE1: The lines then are rendered by the onCameraModified
    // NOTE2: crosshair center are automatically updated in the onCameraModified event
    viewportsAnnotationsToUpdate.forEach((annotation) => {
      this._applyDeltaShiftToViewportCamera(renderingEngine, annotation, delta);
    });
  }

  _applyDeltaShiftToViewportCamera(
    renderingEngine: Types.IRenderingEngine,
    annotation,
    delta
  ) {
    // update camera for the other viewports.
    // NOTE1: The lines then are rendered by the onCameraModified
    // NOTE2: crosshair center are automatically updated in the onCameraModified event
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


  // It filters the viewports with crosshairs and only return viewports
  // that have different camera.
  _getAnnotationsForViewportsWithDifferentCameras = (
    enabledElement,
    annotations
  ) => {
    const { viewportId, renderingEngine, viewport } = enabledElement;

    const otherViewportAnnotations = annotations.filter(
      (annotation) => annotation.data.viewportId !== viewportId
    );

    if (!otherViewportAnnotations || !otherViewportAnnotations.length) {
      return [];
    }

    const camera = viewport.getCamera();
    const { viewPlaneNormal, position } = camera;

    const viewportsWithDifferentCameras = otherViewportAnnotations.filter(
      (annotation) => {
        const { viewportId } = annotation.data;
        const targetViewport = renderingEngine.getViewport(viewportId);
        const cameraOfTarget = targetViewport.getCamera();

        return !(
          csUtils.isEqual(
            cameraOfTarget.viewPlaneNormal,
            viewPlaneNormal,
            1e-2
          ) && csUtils.isEqual(cameraOfTarget.position, position, 1)
        );
      }
    );

    return viewportsWithDifferentCameras;
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


  filterInteractableAnnotationsForElement = (element, annotations) => {
    if (!annotations || !annotations.length) {
      return [];
    }
    return annotations.filter(
      (annotation) => annotation.metadata.toolName === this.getToolName()
    );
  };

  renderAnnotation = (
    enabledElement: Types.IEnabledElement,
    svgDrawingHelper: SVGDrawingHelper
  ): boolean => {
    const { viewport, renderingEngine } = enabledElement;
    const { sourceViewportId, color, lineWidth } = this.configuration;

    const newRtpoints = [];
    const newStpoints = [];

    const annotations = getAnnotations(this.getToolName(), viewport.element);

    if (!annotations || !annotations.length) {
      // console.warn(
      //   `No annotations found for tool ${this.getToolName()} in viewport ${viewport.id}`
      // );
      return false;
    }
    const annotationUID = annotations[0].annotationUID;
    const highlighted = annotations[0].highlighted;

    if (!sourceViewportId) {
      return false;
    }

    const sourceViewport = renderingEngine.getViewport(
      sourceViewportId
    ) as Types.IVolumeViewport;
    if (!sourceViewport || !sourceViewport.getSlabThickness) {
      return false;
    }

    // Current viewport
    const currentCamera = viewport.getCamera();
    const { viewPlaneNormal: n_c, focalPoint: p_c } = currentCamera;

    // Source viewport
    const sourceCamera = sourceViewport.getCamera();
    const { viewPlaneNormal: n_s, focalPoint: p_s } = sourceCamera;
    const slabThickness = sourceViewport.getSlabThickness();

    if (csUtils.isEqual(n_c, n_s)) {
      // Parallel viewports, no intersection line
      return false;
    }

    // Clipping planes of the source viewport
    const p_s1 = vec3.create();
    vec3.scaleAndAdd(p_s1, p_s, n_s, slabThickness / 2);

    const p_s2 = vec3.create();
    vec3.scaleAndAdd(p_s2, p_s, n_s, -slabThickness / 2);

    const planes = [];
    if (slabThickness > 1e-3) {
      planes.push({ normal: n_s, point: p_s1 }, { normal: n_s, point: p_s2 });
    } else {
      // Render just the view plane
      planes.push({ normal: n_s, point: p_s });
    }

    const { clientWidth, clientHeight } = viewport.canvas;
    const canvasBox = [0, 0, clientWidth, clientHeight];

    planes.forEach((plane, index) => {
      const plane1_vtk = csUtils.planar.planeEquation(n_c, p_c);
      const plane2_vtk = csUtils.planar.planeEquation(
        plane.normal,
        plane.point
      );

      const intersectionDirection = vec3.create();
      vec3.cross(intersectionDirection, n_c, plane.normal);

      // if cross product is zero, planes are parallel
      if (vec3.length(intersectionDirection) < 1e-5) {
        return;
      }
      vec3.normalize(intersectionDirection, intersectionDirection);

      let plane3_vtk;
      if (Math.abs(intersectionDirection[0]) > 1e-3) {
        plane3_vtk = csUtils.planar.planeEquation([1, 0, 0], [0, 0, 0]);
      } else if (Math.abs(intersectionDirection[1]) > 1e-3) {
        plane3_vtk = csUtils.planar.planeEquation([0, 1, 0], [0, 0, 0]);
      } else {
        plane3_vtk = csUtils.planar.planeEquation([0, 0, 1], [0, 0, 0]);
      }

      const intersectionPoint = csUtils.planar.threePlaneIntersection(
        plane1_vtk,
        plane2_vtk,
        plane3_vtk
      );

      if (!intersectionPoint) {
        return;
      }

      const longVec = vec3.create();
      vec3.scale(longVec, intersectionDirection, 10000);

      const p1 = vec3.create();
      vec3.add(p1, intersectionPoint, longVec);

      const p2 = vec3.create();
      vec3.subtract(p2, intersectionPoint, longVec);

      const canvasP1 = viewport.worldToCanvas(p1);
      const canvasP2 = viewport.worldToCanvas(p2);


      const isClipped = liangBarksyClip(canvasP1, canvasP2, canvasBox);

      drawLineSvg(
        svgDrawingHelper,
        annotationUID,
        `line_${index}`,
        canvasP1,
        canvasP2,
        {
          color: color,
          lineWidth: highlighted ? lineWidth + 2 : lineWidth,
          lineDash: [5, 2]
        }
      );

      drawCircleSvg(
        svgDrawingHelper,
        annotationUID,
        `rotationPoint_${index}`,
        canvasP1,
        6,
        {
          color: color,
          lineWidth: highlighted ? lineWidth + 2 : lineWidth,
          fillColor: 'white',
        }
      );

      newStpoints.push([
        canvasP1,
        canvasP2
      ]);
    });

    const { element } = viewport;
    const filteredToolAnnotations =
      this.filterInteractableAnnotationsForElement(element, annotations);
    const viewportAnnotation = filteredToolAnnotations[0];
    const data = viewportAnnotation.data;
    // Save new handles points in annotation
    data.handles.rotationPoints = newRtpoints;
    data.handles.slabThicknessPoints = newStpoints;

    return true;
  };
}

export default IntersectionLinesTool;
