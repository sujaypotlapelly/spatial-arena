// Shared by the original presentation and the public flight viewer.
export const scanUrl = "https://code.playcanvas.com/temp/factory/lod-meta.json";
export const colliderUrl = "https://playcanv.as/apps/b466da14/files/assets/284536691/1/Factory_collider.glb";
export const cutShader = `
    uniform float roofHeight;
    void modifySplatCenter(inout vec3 center) {}
    void modifySplatRotationScale(vec3 a, vec3 b, inout vec4 rotation, inout vec3 scale) {}
    void modifySplatColor(vec3 worldCenter, inout vec4 color) {
      // The shared wall at the north edge of the southern corridor runs
      // slightly diagonally in the scan's world XZ plane.
      float southWallZ = 11.8 - 0.035 * worldCenter.x;
      float depthBelowCut = roofHeight - worldCenter.y;
      if (depthBelowCut < 0.0 || worldCenter.z > southWallZ) {
        color.a = 0.0;
        return;
      }
      // Give the exposed cross section a matte concrete finish. Blend back
      // into the photographed surface just below the slice.
      float edge = 1.0 - smoothstep(0.08, 0.36, depthBelowCut);
      float luminance = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
      // Preserve shadowed gaps between the walls.
      float shade = mix(luminance, 0.48, 0.65 * smoothstep(0.04, 0.30, luminance));
      vec3 concrete = shade * vec3(0.98, 0.96, 0.93);
      color.rgb = mix(color.rgb, concrete, edge);
    }
`;

export function loadAsset(pc, app, name, type, url) {
  return new Promise((resolve, reject) => {
    const asset = new pc.Asset(name, type, { url });
    asset.once("load", () => resolve(asset));
    asset.once("error", error => reject(new Error(`${name}: ${error}`)));
    app.assets.add(asset);
    app.assets.load(asset);
  });
}
