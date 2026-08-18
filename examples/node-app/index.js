const express = require('express');

const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Hello from the Portside demo Node app\n');
});

app.listen(port, () => {
  console.log(`listening on ${port}`);
});
