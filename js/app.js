
const state = { config:null, locations:[], map:null, overlay:null, frameLayer:null, tileOverlays:new Map(), tileNeeded:new Set(), tileVisible:new Set(), tiledMode:null, tileRenderScheduled:false, mapZooming:false, markers:new Map(), mode:null, selected:null, filter:"all", query:"", hiddenCategories:new Set(), collapsedGroups:new Set(), descriptionCache:new Map(), themeMode:"light", addPointMode:false, coordinatePicking:false, editingCoordinates:null, addingCoordinates:null, messageTimeout:null };
const $ = s => document.querySelector(s);

async function loadData(){
  const [config, locations, types] = await Promise.all([
    fetch("data/config.json").then(r=>{if(!r.ok)throw Error("Не удалось загрузить config.json");return r.json()}),
    fetch("data/locations.json").then(r=>{if(!r.ok)throw Error("Не удалось загрузить locations.json");return r.json()}),
    fetch("data/types.json").then(r=>{if(!r.ok)throw Error("Не удалось загрузить types.json");return r.json()})
  ]);
  state.config=config; state.locations=locations; state.types=types;
  await Promise.all(locations.map(loc=>loadDescription(loc).catch(()=>null)));
}
function applyTheme(mode=state.themeMode){
  state.themeMode=mode;
  const theme=state.config.theme||{};
  const colors=(mode==="dark"?theme.darkColors:theme.colors)||theme.colors||{};
  Object.entries(colors).forEach(([name,value])=>{
    if(/^[a-z-]+$/.test(name)&&/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value))document.documentElement.style.setProperty(`--${name}`,value);
  });
  state.frameLayer?.setStyle({color:getComputedStyle(document.documentElement).getPropertyValue("--map-border").trim()});
  document.documentElement.dataset.theme=mode;
  const button=$("#theme-toggle");
  if(button){
    button.textContent=mode==="dark"?"Светлая тема":"Тёмная тема";
    button.setAttribute("aria-pressed",String(mode==="dark"));
  }
}
function initMap(){
  const {width,height,minZoom,maxZoom}=state.config.map;
  state.map=L.map("map",{crs:L.CRS.Simple,minZoom,maxZoom,zoomControl:false,attributionControl:false,preferCanvas:true});
  const bounds=[[0,0],[height,width]];
  state.map.fitBounds(bounds);
  state.map.setMaxBounds([[-height*.25,-width*.25],[height*1.25,width*1.25]]);
  const framePane=state.map.createPane("mapFramePane");
  framePane.style.zIndex="450";
  framePane.style.pointerEvents="none";
  const configuredFrameWidth=Number(state.config.map.frameWidth??2);
  const frameWidth=Number.isFinite(configuredFrameWidth)&&configuredFrameWidth>=0&&configuredFrameWidth<=20?configuredFrameWidth:2;
  const frameRenderer=L.canvas({pane:"mapFramePane",padding:0});
  state.frameLayer=L.rectangle(bounds,{
    pane:"mapFramePane",
    renderer:frameRenderer,
    interactive:false,
    fill:false,
    color:getComputedStyle(document.documentElement).getPropertyValue("--map-border").trim(),
    weight:frameWidth,
    opacity:1,
    smoothFactor:0
  }).addTo(state.map);
  state.map.on("click",event=>{
    if(state.coordinatePicking){
      const {width,height}=state.config.map;
      state.editingCoordinates={
        x:Math.round(Math.max(0,Math.min(width,event.latlng.lng))),
        y:Math.round(Math.max(0,Math.min(height,height-event.latlng.lat)))
      };
      setCoordinatePickMode(false);
      $("#edit-point-coordinates").textContent=`Новые координаты: X ${state.editingCoordinates.x}, Y ${state.editingCoordinates.y}`;
      renderMarkers();
      showMapMessage("Место выбрано. Нажмите «Сохранить изменения», чтобы переместить точку.");
      return;
    }
    if(state.addPointMode){
      const {width,height}=state.config.map;
      state.addingCoordinates={
        x:Math.round(Math.max(0,Math.min(width,event.latlng.lng))),
        y:Math.round(Math.max(0,Math.min(height,height-event.latlng.lat)))
      };
      setPointPlacementMode(false);
      renderAddLocationForm();
      return;
    }
    if(state.selected)closeDetail();
  });
  state.map.on("move zoom",scheduleTileRender);
  state.map.on("moveend",()=>{updateScale();scheduleTileRender();});
  state.map.on("zoomstart",()=>{state.mapZooming=true;});
  state.map.on("zoomend",()=>{state.mapZooming=false;updateScale();scheduleTileRender();});
  showMode(state.config.defaultMode);
  updateScale();
}
function showMode(id){
  const mode=state.config.modes.find(m=>m.id===id); if(!mode)return;
  state.mode=id;
  if(state.overlay)state.map.removeLayer(state.overlay);
  state.overlay=null;
  clearTileOverlays();
  state.tiledMode=mode.tiles?mode:null;
  if(state.tiledMode)renderVisibleTiles();
  else{
    state.overlay=L.imageOverlay(mode.image,[[0,0],[state.config.map.height,state.config.map.width]],{interactive:false}).addTo(state.map);
    state.overlay.bringToBack();
  }
  document.querySelectorAll(".mode-btn").forEach(b=>b.classList.toggle("active",b.dataset.mode===id));
  renderMarkers();
}
function clearTileOverlays(){
  for(const tile of state.tileOverlays.values())state.map.removeLayer(tile.layer);
  state.tileOverlays.clear();
  state.tileNeeded.clear();
  state.tileVisible.clear();
}
function scheduleTileRender(){
  if(state.tileRenderScheduled)return;
  state.tileRenderScheduled=true;
  requestAnimationFrame(()=>{
    state.tileRenderScheduled=false;
    renderVisibleTiles();
  });
}
function renderVisibleTiles(){
  const mode=state.tiledMode;
  if(!mode||!state.map)return;
  const tileSet=mode.tiles,tileSize=tileSet.tileSize||512;
  const level=Math.min(tileSet.levels-1,Math.max(0,Math.ceil(-state.map.getZoom())));
  const reduction=2**level;
  const sourceWidth=tileSet.sourceWidth,sourceHeight=tileSet.sourceHeight;
  const worldWidth=state.config.map.width,worldHeight=state.config.map.height;
  const tileWorldWidth=tileSize*reduction*worldWidth/sourceWidth;
  const tileWorldHeight=tileSize*reduction*worldHeight/sourceHeight;
  const columns=Math.ceil(Math.ceil(sourceWidth/reduction)/tileSize);
  const rows=Math.ceil(Math.ceil(sourceHeight/reduction)/tileSize);
  const bounds=state.map.getBounds();
  const left=Math.max(0,bounds.getWest()),right=Math.min(worldWidth,bounds.getEast());
  const top=Math.max(0,worldHeight-bounds.getNorth()),bottom=Math.min(worldHeight,worldHeight-bounds.getSouth());
  const visible=new Set(),needed=new Set();
  if(right>left&&bottom>top){
    const firstColumn=Math.max(0,Math.floor(left/tileWorldWidth));
    const lastColumn=Math.min(columns-1,Math.floor((right-0.000001)/tileWorldWidth));
    const firstRow=Math.max(0,Math.floor(top/tileWorldHeight));
    const lastRow=Math.min(rows-1,Math.floor((bottom-0.000001)/tileWorldHeight));
    for(let row=firstRow;row<=lastRow;row++)for(let column=firstColumn;column<=lastColumn;column++)visible.add(`${level}/${column}_${row}`);
    const bufferedFirstColumn=Math.max(0,firstColumn-1),bufferedLastColumn=Math.min(columns-1,lastColumn+1);
    const bufferedFirstRow=Math.max(0,firstRow-1),bufferedLastRow=Math.min(rows-1,lastRow+1);
    for(let row=bufferedFirstRow;row<=bufferedLastRow;row++)for(let column=bufferedFirstColumn;column<=bufferedLastColumn;column++){
      const key=`${level}/${column}_${row}`;
      needed.add(key);
      if(state.tileOverlays.has(key))continue;
      const tileTop=row*tileWorldHeight,tileLeft=column*tileWorldWidth;
      const tileBottom=Math.min(worldHeight,tileTop+tileWorldHeight);
      const tileRight=Math.min(worldWidth,tileLeft+tileWorldWidth);
      const path=`${tileSet.path}/${level}/${column}_${row}.${tileSet.format||"webp"}`;
      const layer=L.imageOverlay(path,[[worldHeight-tileBottom,tileLeft],[worldHeight-tileTop,tileRight]],{interactive:false,opacity:0});
      const tile={layer,ready:false,failed:false};
      layer.once("load",()=>{tile.ready=true;finishTileUpdate();});
      layer.once("error",()=>{tile.ready=true;tile.failed=true;finishTileUpdate();});
      state.tileOverlays.set(key,tile);
      layer.addTo(state.map);
    }
  }
  state.tileNeeded=needed;
  state.tileVisible=visible;
  finishTileUpdate();
}
function finishTileUpdate(){
  if(state.mapZooming||[...state.tileVisible].some(key=>!state.tileOverlays.get(key)?.ready))return;
  for(const [key,tile] of state.tileOverlays){
      if(state.tileNeeded.has(key)){
        if(tile.ready&&!tile.failed)tile.layer.setOpacity(1);
      }
    else{state.map.removeLayer(tile.layer);state.tileOverlays.delete(key);}
  }
}
function markerIcon(loc,active=false){
  const scale=iconScale(loc),size=30*scale;
  return L.divIcon({className:"",html:`<div class="poi-marker ${active?"active":""}"${iconStyle(loc)}>${iconContent(loc)}</div>`,iconSize:[size,size],iconAnchor:[size/2,size/2]});
}
function iconScale(loc){
  const scale=Number(state.types[loc.type]?.icon?.scale??1);
  return Number.isFinite(scale)&&scale>0&&scale<=3?scale:1;
}
function iconStyle(loc){
  const icon=state.types[loc.type]?.icon||{};
  const scale=iconScale(loc);
  const styles=[];
  if(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(icon.backgroundColor||""))styles.push(`--type-icon-background:${icon.backgroundColor}`);
  styles.push(`--marker-size:${30*scale}px`);
  styles.push(`--marker-symbol-size:${12*scale}px`);
  styles.push(`--marker-image-size:${22*scale}px`);
  styles.push(`--marker-border-width:${2*scale}px`);
  styles.push(`--marker-halo-size:${5*scale}px`);
  styles.push(`--marker-shadow-y:${2*scale}px`);
  styles.push(`--marker-shadow-blur:${8*scale}px`);
  return styles.length?` style="${styles.join(";")}"`:"";
}
function iconContent(loc){
  const icon=state.types[loc.type]?.icon;
  if(icon?.image)return `<img class="custom-icon" src="${escapeHtml(icon.image)}" alt="">`;
  const color=/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(icon?.color||"")?icon.color:"inherit";
  return `<span class="type-symbol" style="color:${color}">${escapeHtml(icon?.symbol||"•")}</span>`;
}
function categoryOf(loc){
  return state.types[loc.type]?.category||loc.type;
}
function visibleInMode(loc){
  return state.mode==="all"||(state.types[loc.type]?.modes||[]).includes(state.mode);
}
function categories(){
  return [...new Set(state.locations.map(categoryOf))].sort((a,b)=>a.localeCompare(b,"ru"));
}
function renderMarkers(){
  for(const marker of state.markers.values())state.map.removeLayer(marker);
  state.markers.clear();
  updateRandomLocationButton();
  state.locations.filter(loc=>visibleInMode(loc)&&!state.hiddenCategories.has(categoryOf(loc))).forEach(loc=>{
    const coordinates=loc.id===state.selected&&state.editingCoordinates||loc.coordinates;
    const marker=L.marker([state.config.map.height-coordinates.y,coordinates.x],{icon:markerIcon(loc,loc.id===state.selected)}).addTo(state.map);
    marker.bindTooltip(loc.name,{direction:"top",offset:[0,-12],className:"poi-tip"});
    marker.on("click",()=>selectLocation(loc.id));
    state.markers.set(loc.id,marker);
  });
}
function renderCategoryFilters(){
  const available=categories();
  if(state.filter!=="all"&&!available.includes(state.filter))state.filter="all";
  $("#category-filters").innerHTML=[`<button class="filter ${state.filter==="all"?"active":""}" data-filter="all">Все</button>`,...available.map(category=>`<button class="filter ${state.filter===category?"active":""}" data-filter="${escapeHtml(category)}">${escapeHtml(category)}</button>`)].join("");
  $("#category-filters").querySelectorAll(".filter").forEach(button=>button.addEventListener("click",()=>{
    state.filter=button.dataset.filter;
    $("#category-filters").querySelectorAll(".filter").forEach(item=>item.classList.toggle("active",item===button));
    renderList();
  }));
  $("#marker-categories").innerHTML=available.map(category=>`<label class="visibility-category"><input type="checkbox" data-marker-category="${escapeHtml(category)}" ${state.hiddenCategories.has(category)?"":"checked"}><span>${escapeHtml(category)}</span></label>`).join("");
  $("#marker-categories").querySelectorAll("[data-marker-category]").forEach(input=>input.addEventListener("change",()=>{
    if(input.checked)state.hiddenCategories.delete(input.dataset.markerCategory);
    else state.hiddenCategories.add(input.dataset.markerCategory);
    updateAllMarkersCheckbox();
    renderMarkers();
  }));
  updateAllMarkersCheckbox();
}
function updateAllMarkersCheckbox(){
  const checkbox=$("#markers-visible"),available=categories();
  const visibleCount=available.filter(category=>!state.hiddenCategories.has(category)).length;
  checkbox.checked=available.length>0&&visibleCount===available.length;
  checkbox.indeterminate=visibleCount>0&&visibleCount<available.length;
}
function renderList(){
  const q=state.query.trim().toLocaleLowerCase("ru");
  const items=state.locations.filter(visibleInMode)
    .filter(loc=>state.filter==="all"||categoryOf(loc)===state.filter)
    .filter(loc=>!q||(loc.name+" "+categoryOf(loc)+" "+(state.descriptionCache.get(loc.descriptionFile)||"")).toLocaleLowerCase("ru").includes(q));
  const groups=new Map();
  for(const loc of items){
    const category=categoryOf(loc);
    if(!groups.has(category))groups.set(category,[]);
    groups.get(category).push(loc);
  }
  $("#object-list").innerHTML=groups.size?[...groups].sort(([a],[b])=>a.localeCompare(b,"ru")).map(([category,locations])=>`
    <details class="object-group" data-group="${escapeHtml(category)}" ${state.collapsedGroups.has(category)?"":"open"}>
      <summary class="object-group-title"><span>${escapeHtml(category)}</span><span class="object-group-count">${locations.length}</span></summary>
      ${locations.sort((a,b)=>a.name.localeCompare(b.name,"ru")).map(loc=>`
        <button class="object-row ${loc.id===state.selected?"selected":""}" data-id="${escapeHtml(loc.id)}">
          <span class="object-icon"${iconStyle(loc)}>${iconContent(loc)}</span>
          <span class="object-meta"><span class="object-name">${escapeHtml(loc.name)}</span></span>
        </button>`).join("")}
    </details>`).join(""):`<div class="empty">Объекты не найдены</div>`;
  const objectList=$("#object-list");
  objectList.querySelectorAll(".object-group").forEach(group=>group.addEventListener("toggle",()=>{
    if(group.open)state.collapsedGroups.delete(group.dataset.group);
    else state.collapsedGroups.add(group.dataset.group);
  }));
  objectList.querySelectorAll(".object-row").forEach(button=>button.addEventListener("click",()=>selectLocation(button.dataset.id)));
}
function selectLocation(id){
  const loc=state.locations.find(x=>x.id===id);if(!loc)return;
  const modes=state.types[loc.type]?.modes||[];
  if(state.mode!=="all"&&!modes.includes(state.mode)&&modes.length)showMode(modes[0]);
  state.selected=id;
  updateShowSelectedButton();renderMarkers();renderList();renderDetail(loc);
}
async function loadDescription(loc){
  if(!loc.descriptionFile)return "";
  if(state.descriptionCache.has(loc.descriptionFile))return state.descriptionCache.get(loc.descriptionFile);
  const response=await fetch(loc.descriptionFile);
  if(!response.ok)throw Error(`Не удалось загрузить ${loc.descriptionFile}`);
  const markdown=await response.text();
  state.descriptionCache.set(loc.descriptionFile,markdown);
  return markdown;
}
function renderInlineMarkdown(text){
  let html=escapeHtml(text);
  html=html.replace(/\[\[([a-zA-Z0-9_-]+)(?:\|([^\]]+))?\]\]/g,(_,id,label)=>{
    const target=state.locations.find(loc=>loc.id===id);
    return `<button class="poi-reference" type="button" data-location="${escapeHtml(id)}">${escapeHtml(label||target?.name||id)}</button>`;
  });
  html=html.replace(/\[([^\]]+)\]\(poi:([a-zA-Z0-9_-]+)\)/g,(_,label,id)=>`<button class="poi-reference" type="button" data-location="${escapeHtml(id)}">${label}</button>`);
  return html.replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>").replace(/\*(.+?)\*/g,"<em>$1</em>").replace(/`([^`]+)`/g,"<code>$1</code>");
}
function renderMarkdown(markdown){
  const output=[];let paragraph=[];let listOpen=false;
  const flushParagraph=()=>{if(paragraph.length){output.push(`<p>${paragraph.map(renderInlineMarkdown).join(" ")}</p>`);paragraph=[];}};
  const closeList=()=>{if(listOpen){output.push("</ul>");listOpen=false;}};
  markdown.split(/\r?\n/).forEach(line=>{
    const heading=line.match(/^(#{1,4})\s+(.+)$/);
    const item=line.match(/^\s*[-*]\s+(.+)$/);
    if(!line.trim()){flushParagraph();closeList();return;}
    if(heading){flushParagraph();closeList();const level=heading[1].length;output.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);return;}
    if(item){flushParagraph();if(!listOpen){output.push("<ul>");listOpen=true;}output.push(`<li>${renderInlineMarkdown(item[1])}</li>`);return;}
    closeList();paragraph.push(line.trim());
  });
  flushParagraph();closeList();
  return output.join("");
}
async function renderDetail(loc){
  let description;
  try{description=await loadDescription(loc);}
  catch(error){description="";}
  if(state.selected!==loc.id)return;
  $("#object-list").hidden=true;$("#detail").classList.add("visible");
  $("#detail").innerHTML=`
    <div class="detail-top"><button class="back-btn" id="back-list">← Все объекты</button></div>
    <h2>${escapeHtml(loc.name)}</h2>
    <div class="detail-category">${escapeHtml(categoryOf(loc))}</div>
    <div class="detail-actions">
      <button class="detail-action" id="edit-location" type="button">Редактировать</button>
      ${loc.descriptionFile?'<button class="detail-action" id="download-description" type="button">Скачать Markdown</button>':""}
      <button class="detail-action danger" id="delete-location" type="button">Удалить точку</button>
    </div>
    <div class="detail-description markdown-content">${renderMarkdown(description||"Описание пока не добавлено.")}</div>
    <p class="detail-status" id="detail-status" role="status" aria-live="polite"></p>`;
  $("#back-list").addEventListener("click",closeDetail);
  $("#edit-location").addEventListener("click",()=>renderEditLocationForm(loc));
  $("#download-description")?.addEventListener("click",()=>downloadDescription(loc));
  $("#delete-location").addEventListener("click",()=>deleteLocation(loc));
}
async function renderEditLocationForm(loc){
  let markdown;
  try{
    markdown=await loadDescription(loc);
  }catch(error){
    showMapMessage(`Не удалось загрузить описание точки: ${error.message}`);
    return;
  }
  if(state.selected!==loc.id)return;
  state.editingCoordinates=null;
  setCoordinatePickMode(false);
  const originalType=loc.type;
  const types=Object.entries(state.types).map(([id,type])=>`<option value="${escapeHtml(id)}" ${id===loc.type?"selected":""}>${escapeHtml(type.category||id)}</option>`).join("");
  $("#detail").innerHTML=`
    <div class="detail-top"><button class="back-btn" id="cancel-edit-location" type="button">← Отмена</button></div>
    <h2>Редактирование точки</h2>
    <form class="add-point-form" id="edit-location-form">
      <label for="edit-point-name">Название</label>
      <input id="edit-point-name" name="name" required maxlength="120" value="${escapeHtml(loc.name)}" autocomplete="off">
      <label for="edit-point-type">Тип</label>
      <select id="edit-point-type" name="type" required>${types}</select>
      <p class="add-point-coordinates" id="edit-point-coordinates">Координаты: X ${loc.coordinates.x}, Y ${loc.coordinates.y}</p>
      <button class="detail-action" id="pick-edit-coordinates" type="button">Выбрать место на карте</button>
      <label for="edit-point-description">Описание (Markdown)</label>
      <textarea id="edit-point-description" name="description" rows="8">${escapeHtml(markdown)}</textarea>
      <p class="form-error" id="edit-point-error" role="alert"></p>
      <button class="add-point-submit" type="submit">Сохранить изменения</button>
    </form>`;
  $("#cancel-edit-location").addEventListener("click",()=>{
    setCoordinatePickMode(false);
    state.editingCoordinates=null;
    renderMarkers();
    renderDetail(loc);
  });
  $("#pick-edit-coordinates").addEventListener("click",()=>{
    setCoordinatePickMode(!state.coordinatePicking);
    if(state.coordinatePicking)showMapMessage("Щёлкните по карте, чтобы выбрать новые координаты точки.");
  });
  $("#edit-location-form").addEventListener("submit",event=>{
    event.preventDefault();
    const form=event.currentTarget,name=$("#edit-point-name").value.trim(),type=$("#edit-point-type").value;
    if(!form.reportValidity())return;
    if(!state.locations.includes(loc))return;
    const description=$("#edit-point-description").value;
    const previousDescriptionFile=loc.descriptionFile;
    loc.name=name;
    loc.type=type;
    if(state.editingCoordinates)loc.coordinates={...state.editingCoordinates};
    setCoordinatePickMode(false);
    state.editingCoordinates=null;
    if(!loc.descriptionFile||type!==originalType){
      loc.descriptionFile=`data/descriptions/${type}/${loc.id}.md`;
    }
    if(previousDescriptionFile&&previousDescriptionFile!==loc.descriptionFile)state.descriptionCache.delete(previousDescriptionFile);
    if(loc.descriptionFile)state.descriptionCache.set(loc.descriptionFile,description);
    renderCategoryFilters();
    selectLocation(loc.id);
    showMapMessage("Изменения точки сохранены в текущем сеансе. Скачайте locations.json, чтобы сохранить их.");
  });
}
async function downloadDescription(loc){
  try{
    const markdown=await loadDescription(loc);
    const filename=loc.descriptionFile.split("/").pop();
    downloadFile(filename,markdown,"text/markdown;charset=utf-8");
  }catch(error){
    const status=$("#detail-status");
    if(status)status.textContent=`Не удалось загрузить описание: ${error.message}`;
  }
}
function deleteLocation(loc){
  if(!window.confirm(`Удалить точку «${loc.name}»? Изменение сохранится после скачивания общего списка.`))return;
  state.locations=state.locations.filter(location=>location.id!==loc.id);
  if(loc.descriptionFile)state.descriptionCache.delete(loc.descriptionFile);
  state.selected=null;
  updateShowSelectedButton();
  $("#detail").classList.remove("visible");
  $("#object-list").hidden=false;
  renderCategoryFilters();
  renderMarkers();
  renderList();
  showMapMessage("Точка удалена из текущего сеанса. Скачайте locations.json, чтобы сохранить изменение.");
}
function closeDetail(){setCoordinatePickMode(false);state.editingCoordinates=null;state.selected=null;updateShowSelectedButton();$("#detail").classList.remove("visible");$("#object-list").hidden=false;renderMarkers();renderList();}
function setCoordinatePickMode(enabled){
  state.coordinatePicking=enabled;
  $("#map").classList.toggle("placing-point",enabled);
  const button=$("#pick-edit-coordinates");
  if(button){
    button.textContent=enabled?"Отменить выбор места":"Выбрать место на карте";
    button.setAttribute("aria-pressed",String(enabled));
  }
}
function setPointPlacementMode(enabled){
  clearTimeout(state.messageTimeout);
  state.messageTimeout=null;
  state.addPointMode=enabled;
  const button=$("#add-point"),map=$("#map"),message=$("#map-message");
  button.classList.toggle("active",enabled);
  button.setAttribute("aria-pressed",String(enabled));
  map.classList.toggle("placing-point",enabled);
  if(enabled){
    message.textContent="Режим добавления: щёлкните по карте, чтобы поставить точку.";
    message.hidden=false;
  }else if(message.textContent.startsWith("Режим добавления:")){
    message.hidden=true;
  }
}
function makeLocationId(name){
  const transliteration={а:"a",б:"b",в:"v",г:"g",д:"d",е:"e",ё:"e",ж:"zh",з:"z",и:"i",й:"y",к:"k",л:"l",м:"m",н:"n",о:"o",п:"p",р:"r",с:"s",т:"t",у:"u",ф:"f",х:"kh",ц:"ts",ч:"ch",ш:"sh",щ:"shch",ъ:"",ы:"y",ь:"",э:"e",ю:"yu",я:"ya"};
  const base=[...name.toLocaleLowerCase("ru")].map(char=>transliteration[char]??char).join("").replace(/[^a-z0-9_-]+/g,"-").replace(/^-+|-+$/g,"")||"location";
  let id=base,suffix=2;
  while(state.locations.some(location=>location.id===id))id=`${base}-${suffix++}`;
  return id;
}
function renderAddLocationForm(){
  const {x,y}=state.addingCoordinates;
  const types=Object.entries(state.types).map(([id,type])=>`<option value="${escapeHtml(id)}">${escapeHtml(type.category||id)}</option>`).join("");
  $("#object-list").hidden=true;
  $("#detail").classList.add("visible");
  $("#detail").innerHTML=`
    <div class="detail-top"><button class="back-btn" id="cancel-add-point" type="button">← Отмена</button></div>
    <h2>Новая точка</h2>
    <p class="add-point-coordinates">Координаты: X ${x}, Y ${y}</p>
    <form class="add-point-form" id="add-point-form">
      <label for="point-name">Название</label>
      <input id="point-name" name="name" required maxlength="120" autocomplete="off">
      <label for="point-id">ID</label>
      <input id="point-id" name="id" required pattern="[A-Za-z0-9_-]+" title="Используйте латинские буквы, цифры, дефис или подчёркивание" autocomplete="off">
      <label for="point-type">Тип</label>
      <select id="point-type" name="type" required>${types}</select>
      <label for="point-description">Описание (Markdown)</label>
      <textarea id="point-description" name="description" rows="6" placeholder="Краткое описание новой точки..."></textarea>
      <p class="form-error" id="point-form-error" role="alert"></p>
      <button class="add-point-submit" type="submit">Добавить точку</button>
      <p class="add-point-help">После добавления скачается Markdown-файл для папки <code>data/descriptions/тип/</code>. Точки остаются в текущем сеансе до скачивания общего списка.</p>
    </form>`;
  const form=$("#add-point-form"),nameInput=$("#point-name"),idInput=$("#point-id");
  let idEdited=false;
  idInput.value=makeLocationId("");
  nameInput.addEventListener("input",()=>{
    if(!idEdited)idInput.value=makeLocationId(nameInput.value);
  });
  idInput.addEventListener("input",()=>{idEdited=true;});
  $("#cancel-add-point").addEventListener("click",closeDetail);
  form.addEventListener("submit",event=>{
    event.preventDefault();
    const name=nameInput.value.trim(),id=idInput.value.trim(),type=$("#point-type").value;
    const error=$("#point-form-error");
    if(!form.reportValidity())return;
    if(state.locations.some(location=>location.id===id)){
      error.textContent="Точка с таким ID уже существует.";
      idInput.focus();
      return;
    }
    const descriptionFile=`data/descriptions/${type}/${id}.md`;
    const markdown=$("#point-description").value.trim()||`# ${name}\n\n`;
    const location={id,name,type,descriptionFile,coordinates:{x,y}};
    state.locations.push(location);
    state.descriptionCache.set(descriptionFile,markdown);
    renderCategoryFilters();
    selectLocation(id);
    showMapMessage("Точка добавлена. Markdown и общий список можно скачать кнопками в карточке и шапке.");
  });
  nameInput.focus();
}
function downloadLocations(){
  downloadFile("locations.json",`${JSON.stringify(state.locations,null,2)}\n`,"application/json;charset=utf-8");
}
async function downloadAllDescriptions(){
  const button=$("#download-descriptions");
  button.disabled=true;
  try{
    const entries=await Promise.all(state.locations.filter(loc=>loc.descriptionFile).map(async loc=>{
      const path=loc.descriptionFile.replace(/\\/g,"/");
      if(!path.startsWith("data/descriptions/")||path.split("/").some(part=>part===".."||part===".")){
        throw Error(`Недопустимый путь Markdown-файла: ${loc.descriptionFile}`);
      }
      const markdown=await loadDescription(loc);
      return {path,content:new TextEncoder().encode(markdown)};
    }));
    if(!entries.length)throw Error("Нет Markdown-файлов для скачивания.");
    downloadBlob("descriptions.zip",createZip(entries),"application/zip");
    showMapMessage(`Скачан архив с ${entries.length} Markdown-файлами. Распакуйте его в корень проекта.`);
  }catch(error){
    showMapMessage(`Не удалось скачать Markdown-файлы: ${error.message}`);
  }finally{
    button.disabled=false;
  }
}
function createZip(entries){
  if(entries.length>65535)throw Error("Слишком много файлов для ZIP-архива.");
  const encoder=new TextEncoder(),localParts=[],centralParts=[];
  const now=new Date(),time=(now.getHours()<<11)|(now.getMinutes()<<5)|(now.getSeconds()>>1);
  const date=((Math.max(1980,now.getFullYear())-1980)<<9)|((now.getMonth()+1)<<5)|now.getDate();
  const crcTable=Uint32Array.from({length:256},(_,index)=>{
    let value=index;
    for(let bit=0;bit<8;bit++)value=(value&1)?(value>>>1)^0xedb88320:value>>>1;
    return value>>>0;
  });
  let offset=0;
  for(const entry of entries){
    const name=encoder.encode(entry.path),content=entry.content;
    if(name.length>65535||content.length>0xffffffff||offset+content.length>0xffffffff)throw Error("Файл слишком велик для ZIP-архива.");
    let crc=0xffffffff;
    for(const byte of content)crc=crcTable[(crc^byte)&0xff]^(crc>>>8);
    crc=(crc^0xffffffff)>>>0;
    const local=new Uint8Array(30+name.length),localView=new DataView(local.buffer);
    localView.setUint32(0,0x04034b50,true);localView.setUint16(4,20,true);localView.setUint16(6,0x0800,true);
    localView.setUint16(8,0,true);localView.setUint16(10,time,true);localView.setUint16(12,date,true);
    localView.setUint32(14,crc,true);localView.setUint32(18,content.length,true);localView.setUint32(22,content.length,true);
    localView.setUint16(26,name.length,true);localView.setUint16(28,0,true);local.set(name,30);
    localParts.push(local,content);
    const central=new Uint8Array(46+name.length),centralView=new DataView(central.buffer);
    centralView.setUint32(0,0x02014b50,true);centralView.setUint16(4,20,true);centralView.setUint16(6,20,true);
    centralView.setUint16(8,0x0800,true);centralView.setUint16(10,0,true);centralView.setUint16(12,time,true);centralView.setUint16(14,date,true);
    centralView.setUint32(16,crc,true);centralView.setUint32(20,content.length,true);centralView.setUint32(24,content.length,true);
    centralView.setUint16(28,name.length,true);centralView.setUint16(30,0,true);centralView.setUint16(32,0,true);
    centralView.setUint16(34,0,true);centralView.setUint16(36,0,true);centralView.setUint32(38,0,true);centralView.setUint32(42,offset,true);
    central.set(name,46);centralParts.push(central);
    offset+=local.length+content.length;
  }
  const centralSize=centralParts.reduce((total,part)=>total+part.length,0);
  if(offset+centralSize>0xffffffff)throw Error("Общий размер ZIP-архива превышает допустимый предел.");
  const end=new Uint8Array(22),endView=new DataView(end.buffer);
  endView.setUint32(0,0x06054b50,true);endView.setUint16(8,entries.length,true);endView.setUint16(10,entries.length,true);
  endView.setUint32(12,centralSize,true);endView.setUint32(16,offset,true);
  return new Blob([...localParts,...centralParts,end],{type:"application/zip"});
}
function downloadBlob(filename,blob){
  const url=URL.createObjectURL(blob),link=document.createElement("a");
  link.href=url;
  link.download=filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function downloadFile(filename,content,type){
  downloadBlob(filename,new Blob([content],{type}));
}
function showMapMessage(text){
  const message=$("#map-message");
  clearTimeout(state.messageTimeout);
  message.textContent=text;
  message.hidden=false;
  state.messageTimeout=setTimeout(()=>{message.hidden=true;},7000);
}
function updateShowSelectedButton(){
  const button=$("#show-selected");
  if(button)button.disabled=!state.selected;
}
function visibleLocations(){
  return state.locations.filter(loc=>visibleInMode(loc)&&!state.hiddenCategories.has(categoryOf(loc)));
}
function updateRandomLocationButton(){
  const button=$("#random-location");
  if(button)button.disabled=visibleLocations().length===0;
}
function showRandomLocation(){
  const locations=visibleLocations();
  if(!locations.length)return;
  const location=locations[Math.floor(Math.random()*locations.length)];
  selectLocation(location.id);
  showSelectedLocation();
}
function showSelectedLocation(){
  const loc=state.locations.find(item=>item.id===state.selected);
  if(!loc||!state.map)return;
  const latLng=[state.config.map.height-loc.coordinates.y,loc.coordinates.x];
  state.map.flyTo(latLng,Math.max(state.map.getZoom(),0),{duration:.55});
}
function updateScale(){
    if (!state.map) return;

    const scale = $("#scale-value");
    if (scale) {
        scale.textContent = Math.round((state.map.getZoom() + 2) * 100) + "%";
    }
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function setupSidebarResize(){
  const main=$(".main"),sidebar=$(".sidebar"),resizer=$("#sidebar-resizer"),storageKey="worldAtlasSidebarWidth";
  const applyWidth=value=>{
    const maximum=Math.floor(main.clientWidth*.5);
    const width=Math.round(Math.max(Math.min(280,maximum),Math.min(maximum,value)));
    main.style.setProperty("--sidebar-width",`${width}px`);
    resizer.setAttribute("aria-valuemin",String(Math.round(Math.min(280,maximum))));
    resizer.setAttribute("aria-valuemax",String(Math.round(maximum)));
    resizer.setAttribute("aria-valuenow",String(width));
  };
  try{
    const savedWidth=Number(localStorage.getItem(storageKey));
    if(!window.matchMedia("(max-width: 650px)").matches)applyWidth(savedWidth||sidebar.getBoundingClientRect().width);
  }catch(error){}
  resizer.addEventListener("pointerdown",event=>{
    if(window.matchMedia("(max-width: 650px)").matches)return;
    event.preventDefault();
    const startX=event.clientX,startWidth=sidebar.getBoundingClientRect().width;
    const move=moveEvent=>applyWidth(startWidth+startX-moveEvent.clientX);
    const finish=()=>{
      document.removeEventListener("pointermove",move);
      document.removeEventListener("pointerup",finish);
      document.removeEventListener("pointercancel",finish);
      try{localStorage.setItem(storageKey,String(sidebar.getBoundingClientRect().width));}catch(error){}
    };
    document.addEventListener("pointermove",move);
    document.addEventListener("pointerup",finish);
    document.addEventListener("pointercancel",finish);
  });
  resizer.addEventListener("keydown",event=>{
    if(event.key!=="ArrowLeft"&&event.key!=="ArrowRight")return;
    event.preventDefault();
    const delta=event.key==="ArrowLeft"?20:-20;
    applyWidth(sidebar.getBoundingClientRect().width+delta);
    try{localStorage.setItem(storageKey,String(sidebar.getBoundingClientRect().width));}catch(error){}
  });
}
function setupUI(){
  setupSidebarResize();
  try{state.themeMode=localStorage.getItem("worldAtlasTheme")==="dark"?"dark":"light";}catch(error){}
  applyTheme(state.themeMode);
  $("#theme-toggle").addEventListener("click",()=>{
    const mode=state.themeMode==="dark"?"light":"dark";
    applyTheme(mode);
    try{localStorage.setItem("worldAtlasTheme",mode);}catch(error){}
  });
  const logo=$(".brand-mark");
  if(logo&&state.config.branding?.logo)logo.src=state.config.branding.logo;
  renderCategoryFilters();
  $("#mode-switch").innerHTML=state.config.modes.map(m=>`<button class="mode-btn" data-mode="${escapeHtml(m.id)}">${escapeHtml(m.label)}</button>`).join("");
  document.querySelectorAll(".mode-btn").forEach(b=>b.addEventListener("click",()=>{closeDetail();showMode(b.dataset.mode);renderList();}));
  $("#search").addEventListener("input",e=>{state.query=e.target.value;renderList();});
  $("#markers-visible").addEventListener("change",event=>{
    const available=categories();
    if(event.target.checked)available.forEach(category=>state.hiddenCategories.delete(category));
    else available.forEach(category=>state.hiddenCategories.add(category));
    $("#marker-categories").querySelectorAll("[data-marker-category]").forEach(input=>{
      input.checked=!state.hiddenCategories.has(input.dataset.markerCategory);
    });
    updateAllMarkersCheckbox();
    renderMarkers();
  });
  $("#detail").addEventListener("click",e=>{const link=e.target.closest("[data-location]");if(link)selectLocation(link.dataset.location);});
  $("#zoom-in").addEventListener("click",()=>state.map.zoomIn());
  $("#zoom-out").addEventListener("click",()=>state.map.zoomOut());
  $("#reset-view").addEventListener("click",()=>state.map.fitBounds([[0,0],[state.config.map.height,state.config.map.width]]));
  $("#show-selected").addEventListener("click",showSelectedLocation);
  $("#random-location").addEventListener("click",showRandomLocation);
  $("#download-locations").addEventListener("click",downloadLocations);
  $("#download-descriptions").addEventListener("click",downloadAllDescriptions);
  $("#add-point").addEventListener("click",()=>{
    if(state.addPointMode){setPointPlacementMode(false);return;}
    if(state.selected||$("#add-point-form"))closeDetail();
    setPointPlacementMode(true);
  });
}
(async function start(){
  try{await loadData();setupUI();initMap();renderList();}
  catch(err){document.body.innerHTML=`<div style="padding:40px;font:16px system-ui">Ошибка запуска: ${escapeHtml(err.message)}<br><br>Откройте проект через локальный веб-сервер, а не напрямую через file://</div>`;}
})();
