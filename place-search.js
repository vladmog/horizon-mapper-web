"use strict";

// Explicit, point-sized lookups only. The terrain laser cannot identify a
// business visually; keep proximity evidence separate from its name.
const PlaceSearch = (() => {
  const endpoint='https://photon.komoot.io/reverse';
  const cache=new Map();
  let lastRequest=0;
  const distance=(a,b)=>{
    const rad=Math.PI/180,x=Math.sin((b.lat-a.lat)*rad/2),y=Math.sin((b.lon-a.lon)*rad/2);
    return 12742017.6*Math.asin(Math.min(1,Math.sqrt(x*x+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*y*y)));
  };
  const valid=p=>p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat)<=85 && Math.abs(p.lon)<=180;
  function records(features) {
    return features.flatMap(feature=>{
      const p=feature.properties || {},c=feature.geometry?.coordinates;
      // Photon extents are bounding boxes, not building footprints. Never use
      // them as evidence that the hit belongs to the returned business.
      if(feature.geometry?.type!=='Point' || !Array.isArray(c))return [];
      const tags={name:p.name,[p.osm_key]:p.osm_value,
        'addr:housenumber':p.housenumber,'addr:street':p.street,
        'addr:city':p.city || p.locality,'addr:postcode':p.postcode,ele:p.extra?.ele};
      if(p.type==='street' && !tags.highway)tags.highway='road';
      if(!['house','street','other'].includes(p.type) && p.osm_key!=='natural')return [];
      return [{type:({N:'node',W:'way',R:'relation'})[p.osm_type],id:p.osm_id,
        lat:c[1],lon:c[0],tags}];
    });
  }
  function rank(point,elements) {
    if(!valid(point))throw new Error('Invalid laser location.');
    const results=[];
    for(const element of elements || []) {
      const t=element.tags || {},name=t['name:en'] || t.name || t.brand;
      const address=[t['addr:housenumber'],t['addr:street'] || t['addr:place']].filter(Boolean).join(' ');
      const fullAddress=[address,t['addr:city'],t['addr:postcode']].filter(Boolean).join(', ');
      const peak=t.natural==='peak' || t.natural==='volcano';
      const business=!!(t.shop || t.office || t.craft || ['cafe','restaurant','bar','pub','fast_food','bank','pharmacy','fuel','cinema'].includes(t.amenity) || ['hotel','motel','guest_house'].includes(t.tourism));
      const category=peak?'Mountain':business?'Business':name && !t.highway?'Place':'Address';
      const title=name || address;
      if(!title)continue;
      if(!valid(element) || !element.type || !Number.isSafeInteger(element.id))continue;
      const location={distance:distance(point,element)};
      const limit=peak?300:category==='Address'?80:60;
      if(location.distance>limit)continue;
      // A nearby summit far above/below the laser hit is not the aimed ridge.
      if(peak && Number.isFinite(point.elev) && Number.isFinite(Number(t.ele)) && Math.abs(Number(t.ele)-point.elev)>200)continue;
      const type=peak?'Mountain':(t.shop || t.office || t.craft || t.amenity || t.tourism || (t.highway?'Street':category)).replaceAll('_',' ');
      results.push({name:title,category,type,address:fullAddress,...location,
        source:`https://www.openstreetmap.org/${element.type}/${element.id}`,
        // Favor proximity; do not let a distant mountain replace a local address.
        score:location.distance+(category==='Address'?20:0)});
    }
    return results.sort((a,b)=>a.score-b.score || a.name.localeCompare(b.name)).slice(0,3);
  }
  function query(point) {
    if(!valid(point))throw new Error('Invalid laser location.');
    return endpoint+'?'+new URLSearchParams({lat:point.lat.toFixed(6),lon:point.lon.toFixed(6),radius:'0.3',limit:'10',lang:'en'});
  }

  async function lookup(point,{signal}={}) {
    const url=query(point),key=url,now=Date.now(),saved=cache.get(key);
    if(saved && now-saved.time<600000)return rank(point,saved.elements);
    if(now-lastRequest<2000)throw new Error('Wait a moment before searching another point.');
    lastRequest=now;
    const response=await fetch(url,{signal,credentials:'omit'});
    if(!response.ok)throw new Error(response.status===429?'Search is busy. Try again shortly.':'Search is unavailable. Try again.');
    const data=await response.json();
    if(!Array.isArray(data.features))throw new Error('Search did not finish. Try again.');
    const elements=records(data.features);
    cache.set(key,{elements,time:Date.now()});
    if(cache.size>64)cache.delete(cache.keys().next().value);
    return rank(point,elements);
  }
  async function destinations(text, signal) {
    const params = new URLSearchParams({q: text, limit: "5", lang: "en"});
    const response = await fetch(new URL("/api/?" + params, endpoint), {signal, credentials: "omit"});
    if (!response.ok) throw new Error(response.status === 429
      ? "Search is busy. Try again shortly." : "Search is unavailable. Try again.");
    const data = await response.json();
    if (!Array.isArray(data.features)) throw new Error("Search did not finish. Try again.");
    return data.features.flatMap(feature => {
      const [lon, lat] = feature.geometry?.coordinates || [];
      if (feature.geometry?.type !== "Point" || !valid({lat, lon}) || Math.abs(lat) > 80) return [];
      const p = feature.properties || {};
      const street = [p.housenumber, p.street].filter(Boolean).join(" ");
      const name = p.name || street;
      if (!name) return [];
      const details = [...new Set([street, p.city || p.locality, p.state, p.country]
        .filter(part => part && part !== name))];
      return [{lat, lon, name, detail: details.join(", ") || [lat, lon].join(", ")}];
    });
  }
  function google(point,result) {
    const query=result?`${result.name} ${result.address || ''} near ${point.lat.toFixed(6)}, ${point.lon.toFixed(6)}`:`${point.lat.toFixed(6)}, ${point.lon.toFixed(6)}`;
    return 'https://www.google.com/search?q='+encodeURIComponent(query);
  }
  return {destinations,lookup,rank,query,google,records};
})();
if(typeof module!=='undefined')module.exports=PlaceSearch;
