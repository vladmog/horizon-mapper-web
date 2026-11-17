'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {rank,query,google,records}=require('../place-search.js');
const point={lat:40,lon:-75,elev:100};
const node=(id,lat,lon,tags)=>({type:'node',id,lat,lon,tags});
test('place search distinguishes businesses, peaks, addresses, and empty terrain',()=>{
  assert.equal(rank(point,[node(1,40,-75,{name:'Coffee House',amenity:'cafe'})])[0].category,'Business');
  assert.equal(rank(point,[node(2,40.001,-75,{name:'Summit',natural:'peak',ele:'150'})])[0].category,'Mountain');
  assert.equal(rank(point,[node(3,40,-75,{'addr:housenumber':'12','addr:street':'Main Street'})])[0].name,'12 Main Street');
  assert.deepEqual(rank(point,[]),[]);
  assert.deepEqual(rank(point,[node(4,40.01,-75,{name:'Far shop',shop:'books'}),node(5,40.001,-75,{name:'Wrong ridge',natural:'peak',ele:'1000'})]),[]);
  const results=rank(point,[node(6,40.002,-75,{name:'Distant summit',natural:'peak'}),node(7,40,-75,{'addr:housenumber':'8','addr:street':'This Street'})]);
  assert.equal(results[0].name,'8 This Street','local address outranks a distant peak');
});
test('Photon responses preserve names and addresses without treating bounding boxes as buildings',()=>{
  const features=[{geometry:{type:'Point',coordinates:[-75.001,40]},properties:{osm_type:'W',osm_id:1,type:'house',name:'Near museum',osm_key:'tourism',osm_value:'museum',extent:[-76,41,-74,39]}},
    {geometry:{type:'Point',coordinates:[-75,40]},properties:{osm_type:'N',osm_id:2,type:'house',housenumber:'12',street:'Main Street',city:'Example'}},
    {geometry:{type:'Point',coordinates:[-75,40]},properties:{osm_type:'R',osm_id:3,type:'city',name:'Whole City'}},
    {geometry:{type:'Point',coordinates:['bad',40]},properties:{osm_type:'N',osm_id:4,type:'house',name:'Malformed'}}];
  const result=rank(point,records(features));
  assert.equal(result.length,1,'distant museum bounding box, city and malformed record cannot identify this point');
  assert.equal(result[0].name,'12 Main Street');assert.equal(result[0].address,'12 Main Street, Example');
});
test('query and Google links use only validated coordinates and escaped names',()=>{
  assert.throws(()=>query({lat:NaN,lon:0}));assert.throws(()=>query({lat:40,lon:181}));
  const request=new URL(query(point));assert.equal(request.searchParams.get('lat'),'40.000000');assert.equal(request.searchParams.get('radius'),'0.3');
  const url=new URL(google(point,{name:'A & B # Coffee',address:'12 Main Street'}));
  assert.equal(url.origin,'https://www.google.com');assert.equal(url.searchParams.get('q'),'A & B # Coffee 12 Main Street near 40.000000, -75.000000');
});
