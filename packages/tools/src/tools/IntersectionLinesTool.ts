import { vec3 } from 'gl-matrix';
import type { Types } from '@cornerstonejs/core';
import {
  getEnabledElements,
  getRenderingEngine,
  getEnabledElementByIds,
  utilities as csUtils,
  Enums,
} from '@cornerstonejs/core';
import {
  getAnnotations,
  addAnnotation,
  removeAnnotation,
} from '../stateManagement/annotation/annotationState';

import { AnnotationTool } from './base';
import { getToolGroup } from '../store/ToolGroupManager';
import { drawLine as drawLineSvg } from '../drawingSvg';
import type { SVGDrawingHelper, Annotation } from '../types';
import liangBarksyClip from '../utilities/math/vec2/liangBarksyClip';

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
          viewportId,
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
      // console.warn(
      //   `No annotations found for tool ${this.getToolName()} in viewport ${viewport.id}`
      // );
      return false;
    }
    const annotationUID = annotations[0].annotationUID;

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

    console.log(viewport.id, n_c, n_s, csUtils.isEqual(n_c, n_s));
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
          lineWidth: lineWidth,
          lineDash: [5,2]
        }
      );
    });

    return true;
  };
}

export default IntersectionLinesTool;
