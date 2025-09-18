import { vec3 } from 'gl-matrix';
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
import { getToolGroup } from '../store/ToolGroupManager';
import {
  drawCircle as drawCircleSvg,
  drawLine as drawLineSvg,
} from '../drawingSvg';
import type {
  SVGDrawingHelper,
  Annotation,
  EventTypes,
  InteractionTypes,
} from '../types';
import liangBarksyClip from '../utilities/math/vec2/liangBarksyClip';
import * as lineSegment from '../utilities/math/line';
import { Events } from '../enums';
import { getViewportIdsWithToolToRender } from '../utilities/viewportFilters';
import vtkMath from '@kitware/vtk.js/Common/Core/Math';
import triggerAnnotationRenderForViewportIds from '../utilities/triggerAnnotationRenderForViewportIds';
import {
  resetElementCursor,
  hideElementCursor,
} from '../cursors/elementCursor';

const { RENDERING_DEFAULTS } = CONSTANTS;

const OPERATION = {
  SLAB: 3,
};

/**
 * This tool renders intersection lines between a source viewport and other viewports.
 * It listens to camera modifications in the source viewport and updates the intersection lines accordingly.
 * Supports dragging lines to adjust the slab thickness.
 */
class IntersectionLinesTool extends AnnotationTool {
  static toolName;

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
    this._removeAnnotations();
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
            slabThicknessPoints: [], // intersection line points for slab thickness interaction
          },
          activeOperation: null,
        },
      };
      addAnnotation(annotation, element);
    });
  }

  _initListener() {
    const sourceViewportId = this.configuration.sourceViewportId;
    if (!sourceViewportId) {
      console.warn(
        `Source viewport id is not set for tool ${this.getToolName()}`
      );
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
      console.warn(
        `Source viewport id is not set for tool ${this.getToolName()}`
      );
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
      if (!enabledElement) {
        return;
      }
      const { element } = enabledElement;
      const annotations = getAnnotations(this.getToolName(), element);
      if (annotations && annotations.length) {
        annotations.forEach((annotation) =>
          removeAnnotation(annotation.annotationUID)
        );
      }
    });
  }

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
      const { data } = annotation;

      if (!data.handles) {
        continue;
      }

      const previousHighlighted = annotation.highlighted;
      data.handles.activeOperation = null;

      const near = this.isPointNearTool(element, annotation, canvasCoords, 6);

      if (near && !previousHighlighted) {
        annotation.highlighted = true;
        imageNeedsUpdate = true;
        data.handles.activeOperation = OPERATION.SLAB;
      } else if (!near && previousHighlighted) {
        annotation.highlighted = false;
        imageNeedsUpdate = true;
      }
    }

    return imageNeedsUpdate;
  };

  _pointNearTool(element, annotation, canvasCoords, proximity) {
    const { data } = annotation;
    const { slabThicknessPoints } = data.handles;

    if (!slabThicknessPoints || slabThicknessPoints.length === 0) {
      return false;
    }

    // Check proximity to each intersection line
    for (let i = 0; i < slabThicknessPoints.length; i++) {
      const linePoints = slabThicknessPoints[i];
      if (!linePoints || linePoints.length < 2) {
        continue;
      }

      const [point1, point2] = linePoints;
      if (!point1 || !point2) {
        continue;
      }

      const distanceToLine = lineSegment.distanceToPoint(
        [point1[0], point1[1]],
        [point2[0], point2[1]],
        [canvasCoords[0], canvasCoords[1]]
      );

      if (distanceToLine <= proximity) {
        data.handles.activeOperation = OPERATION.SLAB;
        return true;
      }
    }

    return false;
  }

  addNewAnnotation(
    evt: EventTypes.InteractionEventType,
    interactionType: InteractionTypes
  ): Annotation {
    const eventDetail = evt.detail;
    const { element } = eventDetail;
    const enabledElement = getEnabledElement(element);
    const { viewport } = enabledElement;

    const annotations = this._getAnnotations(enabledElement);
    const filteredAnnotations = this.filterInteractableAnnotationsForElement(
      viewport.element,
      annotations
    );

    if (filteredAnnotations.length === 0) {
      return null;
    }

    const annotation = filteredAnnotations[0];
    annotation.data.handles.activeOperation = OPERATION.SLAB;

    this._activateModify(element);
    return annotation;
  }

  isPointNearTool = (
    element: HTMLDivElement,
    annotation: Annotation,
    canvasCoords: Types.Point2,
    proximity: number
  ): boolean => {
    return this._pointNearTool(element, annotation, canvasCoords, proximity);
  };

  toolSelectedCallback = (
    evt: EventTypes.InteractionEventType,
    annotation: Annotation,
    interactionType: InteractionTypes
  ): void => {
    const eventDetail = evt.detail;
    const { element, currentPoints } = eventDetail;
    const canvasCoords = currentPoints.canvas;

    annotation.highlighted = true;

    // Find which line is closest to the click point
    const slabThicknessPoints = annotation.data.handles
      .slabThicknessPoints as Types.Point3[];
    let activeLineIndex = -1;
    let closestDistance = Infinity;

    if (slabThicknessPoints && slabThicknessPoints.length > 0) {
      for (let i = 0; i < slabThicknessPoints.length; i++) {
        const linePoints = slabThicknessPoints[i];
        if (!linePoints || linePoints.length < 2) {
          continue;
        }

        const [point1, point2] = linePoints;
        if (!point1 || !point2) {
          continue;
        }

        const distanceToLine = lineSegment.distanceToPoint(
          [point1[0], point1[1]],
          [point2[0], point2[1]],
          [canvasCoords[0], canvasCoords[1]]
        );

        if (distanceToLine < closestDistance) {
          closestDistance = distanceToLine;
          activeLineIndex = i;
        }
      }
    }

    annotation.data.handles.activeLineIndex = activeLineIndex;
    annotation.data.handles.activeOperation = OPERATION.SLAB;

    this.editData = { annotation };

    this._activateModify(element);
    hideElementCursor(element);
    evt.preventDefault();
  };

  _activateModify = (element) => {
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

  _getAnnotations = (enabledElement: Types.IEnabledElement) => {
    const { viewport } = enabledElement;
    const annotations =
      getAnnotations(this.getToolName(), viewport.element) || [];
    return annotations;
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
    const { renderingEngine, viewport } = enabledElement;
    const annotations = this._getAnnotations(enabledElement) as Annotation[];
    const filteredToolAnnotations =
      this.filterInteractableAnnotationsForElement(element, annotations);

    const viewportAnnotation = filteredToolAnnotations[0];
    if (!viewportAnnotation) {
      return;
    }

    const { handles } = viewportAnnotation.data;
    if (handles.activeOperation === OPERATION.SLAB) {
      this._updateSlabThickness(eventDetail, delta, renderingEngine);
    }
  };

  _updateSlabThickness(eventDetail, delta, renderingEngine) {
    const sourceViewportId = this.configuration.sourceViewportId;

    if (!sourceViewportId) {
      return;
    }

    const sourceViewport = renderingEngine.getViewport(
      sourceViewportId
    ) as Types.IVolumeViewport;
    if (!sourceViewport || !sourceViewport.getSlabThickness) {
      return;
    }

    const viewportAnnotation = this.editData?.annotation;
    if (!viewportAnnotation?.data?.handles) {
      console.warn(
        'IntersectionLinesTool: Annotation data not found during drag.'
      );
      return;
    }

    const activeLineIndex = viewportAnnotation.data.handles.activeLineIndex;

    if (activeLineIndex === undefined || activeLineIndex === -1) {
      console.warn(
        'IntersectionLinesTool: No active line index found during drag.'
      );
      return;
    }

    const camera = sourceViewport.getCamera();
    const normal = camera.viewPlaneNormal;
    const dotProd = vtkMath.dot(delta, normal);

    if (Math.abs(dotProd) < 1e-5) {
      return;
    }

    let slabThicknessValue = sourceViewport.getSlabThickness();

    // The intersection lines are created in _calculateIntersectionLines with:
    // line 0: +slabThickness / 2
    // line 1: -slabThickness / 2
    if (activeLineIndex === 0) {
      slabThicknessValue += dotProd;
    } else {
      slabThicknessValue -= dotProd;
    }

    slabThicknessValue = Math.max(
      RENDERING_DEFAULTS.MINIMUM_SLAB_THICKNESS,
      slabThicknessValue
    );

    sourceViewport.setSlabThickness(slabThicknessValue);
    renderingEngine.render();
  }

  _endCallback = (evt: EventTypes.InteractionEventType) => {
    const eventDetail = evt.detail;
    const { element } = eventDetail;

    if (this.editData && this.editData.annotation) {
      this.editData.annotation.data.handles.activeOperation = null;
    }

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

    const annotations = getAnnotations(this.getToolName(), viewport.element);
    if (!annotations || !annotations.length) {
      return false;
    }

    const annotation = annotations[0];
    const annotationUID = annotation.annotationUID;
    const highlighted = annotation.highlighted;

    if (!sourceViewportId) {
      return false;
    }

    const sourceViewport = renderingEngine.getViewport(
      sourceViewportId
    ) as Types.IVolumeViewport;
    if (!sourceViewport || !sourceViewport.getSlabThickness) {
      return false;
    }

    // Current viewport camera
    const currentCamera = viewport.getCamera();
    const { viewPlaneNormal: n_c, focalPoint: p_c } = currentCamera;

    // Source viewport camera
    const sourceCamera = sourceViewport.getCamera();
    const { viewPlaneNormal: n_s, focalPoint: p_s } = sourceCamera;
    const slabThickness = sourceViewport.getSlabThickness();

    // Check if viewports are parallel (no intersection)
    if (csUtils.isEqual(n_c, n_s, 1e-3)) {
      return false;
    }

    // Calculate intersection lines
    const intersectionLines = this._calculateIntersectionLines(
      n_c,
      p_c,
      n_s,
      p_s,
      slabThickness,
      viewport
    );

    if (intersectionLines.length === 0) {
      return false;
    }

    // Store intersection points for interaction
    const newSlabThicknessPoints = [];

    // Render each intersection line
    intersectionLines.forEach((line, index) => {
      const { canvasP1, canvasP2 } = line;

      // Draw the intersection line
      drawLineSvg(
        svgDrawingHelper,
        annotationUID,
        `line_${index}`,
        canvasP1,
        canvasP2,
        {
          color: color,
          lineWidth: highlighted ? lineWidth + 2 : lineWidth,
          lineDash: slabThickness > 1e-3 ? [5, 2] : [],
        }
      );

      // Draw interaction handles at line endpoints
      if (highlighted) {
        drawCircleSvg(
          svgDrawingHelper,
          annotationUID,
          `handle_${index}_start`,
          canvasP1,
          4,
          {
            color: color,
            lineWidth: 1,
            fillColor: 'white',
          }
        );

        drawCircleSvg(
          svgDrawingHelper,
          annotationUID,
          `handle_${index}_end`,
          canvasP2,
          4,
          {
            color: color,
            lineWidth: 1,
            fillColor: 'white',
          }
        );
      }

      // Store line points for interaction detection
      newSlabThicknessPoints.push([canvasP1, canvasP2]);
    });

    // Update annotation data with new intersection points
    annotation.data.handles.slabThicknessPoints = newSlabThicknessPoints;

    return true;
  };

  _calculateIntersectionLines(n_c, p_c, n_s, p_s, slabThickness, viewport) {
    const intersectionLines = [];
    const { clientWidth, clientHeight } = viewport.canvas;
    const canvasBox = [0, 0, clientWidth, clientHeight];

    // Define clipping planes based on slab thickness
    const planes = [];
    if (slabThickness > 1e-3) {
      // Two planes for slab thickness
      const p_s1 = vec3.create();
      vec3.scaleAndAdd(p_s1, p_s, n_s, slabThickness / 2);

      const p_s2 = vec3.create();
      vec3.scaleAndAdd(p_s2, p_s, n_s, -slabThickness / 2);

      planes.push(
        { normal: [...n_s], point: p_s1 },
        { normal: vec3.negate(vec3.create(), n_s), point: p_s2 }
      );
    } else {
      // Single plane
      planes.push({ normal: [...n_s], point: p_s });
    }

    planes.forEach((plane) => {
      const intersectionLine = this._calculatePlaneIntersection(
        n_c,
        p_c,
        plane.normal,
        plane.point,
        viewport,
        canvasBox
      );

      if (intersectionLine) {
        intersectionLines.push(intersectionLine);
      }
    });

    return intersectionLines;
  }

  _calculatePlaneIntersection(
    n_c,
    p_c,
    plane_normal,
    plane_point,
    viewport,
    canvasBox
  ) {
    // Calculate intersection direction (cross product of normals)
    const intersectionDirection = vec3.create();
    vec3.cross(intersectionDirection, n_c, plane_normal);

    // If cross product is zero, planes are parallel
    if (vec3.length(intersectionDirection) < 1e-5) {
      return null;
    }
    vec3.normalize(intersectionDirection, intersectionDirection);

    // Find intersection point using three-plane intersection
    const plane1_vtk = csUtils.planar.planeEquation(n_c, p_c);
    const plane2_vtk = csUtils.planar.planeEquation(plane_normal, plane_point);

    // Third plane perpendicular to intersection direction
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
      return null;
    }

    // Create line endpoints far from intersection point
    const longVec = vec3.create();
    vec3.scale(longVec, intersectionDirection, 10000);

    const p1 = vec3.create();
    vec3.add(p1, intersectionPoint, longVec);

    const p2 = vec3.create();
    vec3.subtract(p2, intersectionPoint, longVec);

    // Convert to canvas coordinates
    const canvasP1 = viewport.worldToCanvas(p1);
    const canvasP2 = viewport.worldToCanvas(p2);

    // Clip line to canvas bounds
    const clipped = liangBarksyClip(canvasP1, canvasP2, canvasBox);
    if (!clipped) {
      return null;
    }

    return { canvasP1, canvasP2 };
  }

  handleSelectedCallback = (): void => {
    return null;
  };

  cancel = (): void => {
    return null;
  };
}
IntersectionLinesTool.toolName = 'IntersectionLines';
export default IntersectionLinesTool;
