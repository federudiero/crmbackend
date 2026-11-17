import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChatbotCatalogEstimate, sameChatbotCatalogEstimate, chatbotEstimateText } from '../lib/chatbotCommercialQuote.js';
import { validateFlowDefinition } from '../lib/chatbotFlow.js';

const catalog = { id:'cba', revision:2, active:true, currency:'ARS', products:[
  {sku:'LATEX',name:'Látex premium',price:34000,presentation:'20 L',active:true},
  {sku:'MEM',name:'Membrana',price:39000,presentation:'20 L',active:true},
  {sku:'NO',name:'Sin stock comercial',price:3500,active:false},
]};
const flow = {catalogQuote:{enabled:true,items:[
  {skuAnswerKeys:['sku_1a','sku_1b'],quantityAnswerKey:'qty1'},
  {skuAnswerKeys:['sku_2a','sku_2b'],quantityAnswerKey:'qty2'},
  {skuAnswerKeys:['sku_3a','sku_3b'],quantityAnswerKey:'qty3'},
]}};
const answers = {sku_1a:{value:'LATEX'},qty1:{value:2},sku_2b:{value:'MEM'},qty2:{value:1}};
test('carrito multi-producto suma subtotales de catálogo autorizado y marca stock/envío como no verificados',()=>{
 const q=buildChatbotCatalogEstimate(flow,answers,catalog);
 assert.equal(q.items.length,2);
 assert.equal(q.subtotal,107000);
 assert.equal(q.finalTotalVerified,false);
 assert.equal(q.shippingVerified,false);
 assert.equal(q.availabilityVerified,false);
 assert.match(chatbotEstimateText(q),/Látex premium/);
 assert.match(chatbotEstimateText(q),/Membrana/);
});
test('la misma referencia SKU elegida dos veces se agrupa sin duplicar líneas',()=>{
 const q=buildChatbotCatalogEstimate(flow,{...answers,sku_2b:{value:'LATEX'}},catalog);
 assert.equal(q.items.length,1);
 assert.equal(q.items[0].quantity,3);
 assert.equal(q.subtotal,102000);
});
test('rechaza cotizar SKU inactivo, faltante, cantidades decimales y selección ambigua',()=>{
 for(const broken of [
  {...answers,sku_2b:{value:'NO'}},
  {...answers,sku_2b:{value:'INEXISTENTE'}},
  {...answers,qty2:{value:1.5}},
  {...answers,sku_1b:{value:'MEM'}},
  {...answers,qty3:{value:1}},
 ]) assert.equal(buildChatbotCatalogEstimate(flow,broken,catalog),null);
});
test('detecta cambios en cualquier línea o revisión del catálogo antes de confirmar',()=>{
 const before=buildChatbotCatalogEstimate(flow,answers,catalog);
 assert.equal(sameChatbotCatalogEstimate(before,buildChatbotCatalogEstimate(flow,answers,catalog)),true);
 assert.equal(sameChatbotCatalogEstimate(before,buildChatbotCatalogEstimate(flow,answers,{...catalog,revision:3})),false);
 assert.equal(sameChatbotCatalogEstimate(before,buildChatbotCatalogEstimate(flow,answers,{...catalog,products:catalog.products.map(p=>p.sku==='MEM'?{...p,price:40000}:p)})),false);
});
test('el motor mantiene la compatibilidad con configuración de una sola línea',()=>{
 const q=buildChatbotCatalogEstimate({catalogQuote:{enabled:true,skuAnswerKey:'sku',quantityAnswerKey:'qty'}},{sku:{value:'LATEX'},qty:{value:1}},catalog);
 assert.equal(q.sku,'LATEX');assert.equal(q.unitPrice,34000);assert.equal(q.items.length,1);
});
test('validación rechaza reutilizar claves de respuestas en distintas líneas',()=>{
 const input={name:'Carrito', confirmation:{enabled:true}, startQuestionId:'a',catalogQuote:{enabled:true,items:[
  {skuAnswerKeys:['sku'],quantityAnswerKey:'qty'}, {skuAnswerKeys:['sku'],quantityAnswerKey:'qty2'}
 ]},questions:[
  {id:'a',key:'sku',prompt:'Producto',type:'list',options:[{id:'op',value:'LATEX',label:'Látex'}],nextQuestionId:'b'},
  {id:'b',key:'qty',prompt:'Cantidad 1',type:'number',nextQuestionId:'c'},
  {id:'c',key:'qty2',prompt:'Cantidad 2',type:'number'}
 ]};
 assert.equal(validateFlowDefinition(input).valid,false);
 assert.ok(validateFlowDefinition(input).errors.some(x=>x.code==='duplicate'));
});
