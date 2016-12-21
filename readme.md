# remove test files
```
git rm __mocks__ -r
git rm __tests__ -r
git rm */__mocks__ -r
git rm */__tests__ -r
git rm */*/__mocks__ -r
git rm */*/__tests__ -r
```

# change to *.ts
```
bo1014240@IPP-LTP-6274DJL MINGW64 D:/relay-digest (master)
$ for f in */*.js; do mv -- "$f" "${f%.js}.ts";  done     #first layer
$ for f in */*/*.js; do mv -- "$f" "${f%.js}.ts";  done   #nested layer
```