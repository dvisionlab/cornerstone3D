import { vec2, vec3 } from 'gl-matrix';
import vtkMath from '@kitware/vtk.js/Common/Core/Math';
import { utilities as csUtils, type Types } from '@cornerstonejs/core';
import liangBarksyClip from '../../utilities/math/vec2/liangBarksyClip';
import type { SVGDrawingHelper } from '../../types';
import _getHash from '../../drawingSvg/_getHash';
import setNewAttributesIfValid from '../../drawingSvg/setNewAttributesIfValid';
import setAttributesIfNecessary from '../../drawingSvg/setAttributesIfNecessary';


const OPERATION = {
  DRAG: 1,
  ROTATE: 2,
  SLAB: 3,
};

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


export function lineIntersection2D(p1, p2, q1, q2) {
    const s1_x = p2[0] - p1[0];
    const s1_y = p2[1] - p1[1];
    const s2_x = q2[0] - q1[0];
    const s2_y = q2[1] - q1[1];
    const denom = -s2_x * s1_y + s1_x * s2_y;
    if (Math.abs(denom) < 1e-8) {
      return null;
    }
    const s = (-s1_y * (p1[0] - q1[0]) + s1_x * (p1[1] - q1[1])) / denom;
    const t = (s2_x * (p1[1] - q1[1]) - s2_y * (p1[0] - q1[0])) / denom;
    if (s >= 0 && s <= 1 && t >= 0 && t <= 1) {
      return [p1[0] + t * s1_x, p1[1] + t * s1_y];
    }
    return null;
  }

export function calculateReferenceLines(
    viewport: Types.IViewport,
    toolCenterMin: Types.Point3,
    toolCenterMax: Types.Point3,
    otherViewportAnnotations: any[],
    renderingEngine: Types.IRenderingEngine
  ) {
    const referenceLines = [];
    const { clientWidth, clientHeight } = viewport.canvas;
    const canvasDiagonalLength = Math.sqrt(
      clientWidth * clientWidth + clientHeight * clientHeight
    );
    const canvasBox = [0, 0, clientWidth, clientHeight];
    const camera = viewport.getCamera();

    otherViewportAnnotations.forEach((annotation) => {
      const data = annotation.data;

      let otherViewport,
        otherCanvasDiagonalLength,
        otherCanvasCenter,
        otherViewportCenterWorld;

      otherViewport = renderingEngine.getViewport(data.viewportId as string);
      if (!otherViewport) {
        return; // Skip if the viewport doesn't exist
      }

      const otherClientWidth = otherViewport.canvas.clientWidth;
      const otherClientHeight = otherViewport.canvas.clientHeight;
      otherCanvasDiagonalLength = Math.sqrt(
        otherClientWidth * otherClientWidth + otherClientHeight * otherClientHeight
      );
      otherCanvasCenter = [otherClientWidth * 0.5, otherClientHeight * 0.5];
      otherViewportCenterWorld = otherViewport.canvasToWorld(otherCanvasCenter);

      const orientation = (annotation.data.orientation || '').toUpperCase();
      const axes = AXIS_MAP[orientation] || AXIS_MAP['AXIAL'];

      axes.forEach((axis, axisIndex) => {
        const clippingNormal = axis.normal as [number, number, number];

        const direction = [0, 0, 0];
        vtkMath.cross(
          camera.viewPlaneNormal as [number, number, number],
          clippingNormal,
          direction as [number, number, number]
        );
        vtkMath.normalize(direction as [number, number, number]);
        vtkMath.multiplyScalar(
          direction as [number, number, number],
          otherCanvasDiagonalLength
        );

        const pointWorld0: [number, number, number] = [0, 0, 0];
        vtkMath.add(
          otherViewportCenterWorld as [number, number, number],
          direction as [number, number, number],
          pointWorld0
        );
        const pointWorld1: [number, number, number] = [0, 0, 0];
        vtkMath.subtract(
          otherViewportCenterWorld as [number, number, number],
          direction as [number, number, number],
          pointWorld1
        );

        const pointCanvas0 = viewport.worldToCanvas(pointWorld0 as Types.Point3);
        const otherViewportCenterCanvas = viewport.worldToCanvas([
          otherViewportCenterWorld[0] ?? 0,
          otherViewportCenterWorld[1] ?? 0,
          otherViewportCenterWorld[2] ?? 0,
        ] as [number, number, number] as Types.Point3);

        const canvasUnitVectorFromCenter = vec2.create();
        vec2.subtract(
          canvasUnitVectorFromCenter,
          pointCanvas0,
          otherViewportCenterCanvas
        );
        vec2.normalize(canvasUnitVectorFromCenter, canvasUnitVectorFromCenter);

        const canvasVectorFromCenterLong = vec2.create();
        vec2.scale(
          canvasVectorFromCenterLong,
          canvasUnitVectorFromCenter,
          canvasDiagonalLength * 100
        );

        let minCenter, maxCenter;
        if (axis.name === 'X') {
          minCenter = viewport.worldToCanvas([toolCenterMin[0], otherViewportCenterWorld[1], otherViewportCenterWorld[2]]);
          maxCenter = viewport.worldToCanvas([toolCenterMax[0], otherViewportCenterWorld[1], otherViewportCenterWorld[2]]);
        } else if (axis.name === 'Y') {
          minCenter = viewport.worldToCanvas([otherViewportCenterWorld[0], toolCenterMin[1], otherViewportCenterWorld[2]]);
          maxCenter = viewport.worldToCanvas([otherViewportCenterWorld[0], toolCenterMax[1], otherViewportCenterWorld[2]]);
        } else if (axis.name === 'Z') {
          minCenter = viewport.worldToCanvas([otherViewportCenterWorld[0], otherViewportCenterWorld[1], toolCenterMin[2]]);
          maxCenter = viewport.worldToCanvas([otherViewportCenterWorld[0], otherViewportCenterWorld[1], toolCenterMax[2]]);
        }

        const refLinesCenterMin = vec2.clone(minCenter);
        const refLinePointMinOne = vec2.create();
        const refLinePointMinTwo = vec2.create();
        vec2.add(refLinePointMinOne, refLinesCenterMin, canvasVectorFromCenterLong);
        vec2.subtract(refLinePointMinTwo, refLinesCenterMin, canvasVectorFromCenterLong);
        liangBarksyClip(refLinePointMinOne, refLinePointMinTwo, canvasBox);
        referenceLines.push([
          otherViewport,
          refLinePointMinOne,
          refLinePointMinTwo,
          'min',
          axisIndex,
          axis.name,
        ]);

        const refLinesCenterMax = vec2.clone(maxCenter);
        const refLinePointMaxOne = vec2.create();
        const refLinePointMaxTwo = vec2.create();
        vec2.add(refLinePointMaxOne, refLinesCenterMax, canvasVectorFromCenterLong);
        vec2.subtract(refLinePointMaxTwo, refLinesCenterMax, canvasVectorFromCenterLong);
        liangBarksyClip(refLinePointMaxOne, refLinePointMaxTwo, canvasBox);
        referenceLines.push([
          otherViewport,
          refLinePointMaxOne,
          refLinePointMaxTwo,
          'max',
          axisIndex,
          axis.name,
        ]);
      });
    });

    return referenceLines;
  }

  export function calculateIntersections(referenceLines, lineIndex) {
    const intersections = [];
    const line = referenceLines[lineIndex];
    for (let j = 0; j < referenceLines.length; ++j) {
      if (j === lineIndex) {
        continue;
      }
      const otherLine = referenceLines[j];
      const intersection = lineIntersection2D(
        line[1],
        line[2],
        otherLine[1],
        otherLine[2]
      );
      if (intersection) {
        intersections.push({
          with: otherLine[3], // 'min' or 'max'
          point: intersection,
        });
      }
    }
    return intersections;
  }

  export function calculateDragDelta(evt, annotation, viewport) {
    const { deltaPoints } = evt.detail;
    const delta = deltaPoints.world;
    const { data } = annotation;
    const { handles } = data;
    const { activeOperation } = handles;

    if (activeOperation === OPERATION.DRAG) {
      const { activeViewportIds } = data;
      const { renderingEngine } = getEnabledElement(viewport.element);

      const activeViewport = renderingEngine.getViewport(activeViewportIds[0]);
      const { camera } = activeViewport;
      const { viewPlaneNormal } = camera;

      const line = data.referenceLines.find(
        (line) => line[0].id === activeViewportIds[0]
      );

      if (!line) {
        return [0, 0, 0];
      }

      const axis = AXIS_MAP[data.orientation.toUpperCase()].find(
        (axis) => axis.name === line[5]
      );

      if (!axis) {
        return [0, 0, 0];
      }

      const dragDirection = vec3.fromValues(
        delta[0],
        delta[1],
        delta[2]
      );

      const normalVec3 = vec3.fromValues(axis.normal[0], axis.normal[1], axis.normal[2]);
      const dot = vec3.dot(dragDirection, normalVec3);

      const projectedDelta = vec3.create();
      vec3.scale(projectedDelta, normalVec3, dot);

      return projectedDelta;
    }

    return [0, 0, 0];
  }


/**
 * Disegna un path SVG composto da un perimetro esterno e un "buco" rettangolare interno.
 * Utilizza la regola 'evenodd' per creare l'effetto di un overlay con un'area trasparente.
 *
 * @param svgDrawingHelper - L'helper per il disegno SVG.
 * @param annotationUID - L'UID dell'annotazione a cui associare il path.
 * @param pathUID - L'UID specifico per questo elemento path.
 * @param outerPoints - I vertici del perimetro esterno (es. la viewport).
 * @param holePoints - I vertici del buco interno (es. il box di cropping).
 * @param options - Opzioni di stile come colore e opacità.
 */
export default function drawPathWithHole(
  svgDrawingHelper: SVGDrawingHelper,
  annotationUID: string,
  pathUID: string,
  outerPoints: Types.Point2[],
  holePoints: Types.Point2[],
  options: {
    fillColor?: string;
    fillOpacity?: number;
  }
): void {
  const { fillColor = '#000', fillOpacity = 0.5 } = options;

  // Combina i due set di punti in un unico array per la funzione `drawPath`.
  // L'ordine è importante per la regola di riempimento.
  const pointsArrays = [outerPoints, holePoints];
  let pointsAttribute = '';

  // Costruisce l'attributo 'd' del path SVG
  for (const points of pointsArrays) {
    points.forEach((point, index) => {
      const cmd = index === 0 ? 'M' : 'L';
      pointsAttribute += `${cmd} ${point[0]} ${point[1]} `;
    });
    pointsAttribute += 'Z '; // Chiude ogni forma (sia esterna che interna)
  }

  if (!pointsAttribute) {
    return;
  }

  const svgns = 'http://www.w3.org/2000/svg';
  const svgNodeHash = _getHash(annotationUID, 'path', pathUID);
  const existingNode = svgDrawingHelper.getSvgNode(svgNodeHash);

  const attributes = {
    d: pointsAttribute,
    fill: fillColor,
    'fill-opacity': String(fillOpacity),
    'fill-rule': 'evenodd', // L'attributo chiave per creare il "buco"
    stroke: 'none', // L'overlay non ha bordi
    'pointer-events': 'none', // Non deve intercettare gli eventi del mouse
  };

  if (existingNode) {
    setAttributesIfNecessary(attributes, existingNode);
    svgDrawingHelper.setNodeTouched(svgNodeHash);
  } else {
    const newNode = document.createElementNS(svgns, 'path');
    setNewAttributesIfValid(attributes, newNode);
    svgDrawingHelper.appendNode(newNode, svgNodeHash);
  }
}
