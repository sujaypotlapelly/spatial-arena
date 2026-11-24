# Notices and credits

The code in this repository is released under the [MIT License](LICENSE). The MIT License does not cover the third-party scans and models below, or data derived from them; they keep their own licences.

## Factory scan

- **Gaussian-splat scan** by Christoph Schindelar ([superspl.at/user/schindelar3d](https://superspl.at/user/schindelar3d)).
- **Collision mesh** from [Iakov Sumygin's PlayCanvas project](https://playcanvas.com/project/1480299).

`sim/maps/factory.json` and `sim/maps/factory-full.json` contain collision grids derived from the factory mesh. The original project and its [author’s account of the build](https://blog.playcanvas.com/turning-a-gaussian-splat-into-a-videogame/) identify the creators. We have no recorded license or permission covering redistribution of these derived maps. The code license applies only to the software.

## Other scanned scenes

The following scenes are licensed under [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/). Spatial Arena uses their geometry to build collision grids and flight volumes and renders views of selected scenes. The scene manifests preserve the source records and transforms.

- [Autumn in the woods (Windberg, Freital/Germany)](https://superspl.at/scene/8615117a) — hollmar
- [Calico Basin at sunrise, Red Rock Canyon, Las Vegas NV](https://superspl.at/scene/5d517144) — tosolini
- [Zohar Riverbad, Dead sea, Israel](https://superspl.at/scene/7aa4d3d4) — barak9177
- [church ruins](https://superspl.at/scene/310abb3c) — priceburnett
- [Iran's Beauty - Yazd - Daregahan](https://superspl.at/scene/8652a3e8) — parsamahdavi48
- [Arches National Park - Double Arch](https://superspl.at/scene/91fafbc3) — virtualworldtours
- [World's End Inn](https://superspl.at/scene/8ee91366) — artfletch
- [Taşçılar Göleti](https://superspl.at/scene/d5e57a5b) — eakturk
- [Forest Scan](https://superspl.at/scene/259c0051) — draftmode
- [Lodge on a hill](https://superspl.at/scene/c393e279) — zartan_3dfpv
- [The Precipitous Huashan, Virtual Hiking](https://superspl.at/scene/aa909429) — wu3d
- [Dorfplatz Interlaken Switzerland](https://superspl.at/scene/16a90551) — dewaisol
- [Utlida 1:80](https://superspl.at/scene/5f41cc74) — 3D capture and Gaussian Splat by Jakob Safwan / Overblick Studio ([studio website](https://www.overblickstudio.se)).
- [SS United States Cruise Ship - AFT Lines Room](https://superspl.at/scene/eb9df574) — seventysevenguy. Scan created by Anatum Geomobile using XGRIDS PortalCAM.
- [Sunny Meadow](https://superspl.at/scene/3aacb9d5) — alienhd
- [Verzasca River - Ponte dei Salti, Switzerland](https://superspl.at/scene/fb6b9fae) — tosolini

## 3D models (CC BY 4.0)

Bundled in `sim/assets/flight/`, with a parent transform added for scale, pivot and forward direction.

- **DJI FPV** by Vitalii Sushko ([Sketchfab](https://sketchfab.com/3d-models/dji-fpv-28321515f60346c0becb244ed094c1f8))
- **White Eagle Animation Fast Fly** by GremorySaiyan ([Sketchfab](https://sketchfab.com/3d-models/white-eagle-animation-fast-fly-30203bf39e5145f19c79e83c550139d3))

## Model

Results use [Ripple-65B-Preview](https://huggingface.co/ricursiveAI/Ripple-65B-Preview) through OpenRouter. No model weights are included here.
