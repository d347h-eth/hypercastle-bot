const options = {method: 'GET', headers: {accept: '*/*', 'x-api-key': 'demo-api-key'}};

fetch('https://terravoir.artgod.network/sales/v6?collection=0x4e1f41613c9084fdb9e34e11fae9412427480e56&sortBy=time&sortDirection=desc', options)
  .then(res => res.json())
  .then(res => console.log(res))
  .catch(err => console.error(err));