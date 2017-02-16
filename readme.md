# `Relay Deep Dive` by Greg Hurrell
## process
```
schema.json -> babel-relay-plugin -> Relay.QL`query{ rootQuery}` --> query AST (Abstract Syntax Tree)
Diff with Store data (available at client)  --> Split ( RelayQueryTransform, traverse the query ) -> print (graphQL server doesn't speak AST)
                       ||
                       ||
                       \/
                 GRAPHQL SERVER
                       ||
                       ||
                       \/
receive query payload:
Write payload (traverse the query with response data and store data into store. RelayQueryWriter, _writeScalar, write into normalized store)
Notify subscribers (i.e. mutation case: RelayContainer's _handleFragmentDataUpdate)
Read query data (another traversal , readRelayQueryData, _readScalar, better known as fragmentResolvers.resolve)
Render
```

## QueryNode/AST is the thread that piece everything together
>* `query = {viewer{ store{id, name}}}` ==> babel-relay-plugin ==> AST ==> DIFF/SPLIT/DEFER ==> PRINT => server request
>*                         http traffic
>* flatterned record store <======= AST to build serializationKey, which is the data Covenant  <=========:save  respone data
>* flatterned record store <======= AST to build serializationKey, which is the data Covenant  <=========:read  relay container

## Traversal : RelayQueryVisitor (read version, base Class)
```
    + RelayQueryTransform (read-write version, for SPLITTING, Deferring..etc. transform graphql Query and send to server)
    + RelayQueryWrite : read version; utilize AST to pluck responsedata (POJO) and save into _recordStore
    + readRelayQueryData: read version; traverse(node, nextState)  use nextState to hold returned data (this is the props for relay container); 
                          for RelayContainer to get response data from store using AST as key
```

>AST is the most important thing in relay; it participate in the entire process of relay
>you first write query in graphql , which is string; then babel-relay plug in parse that into AST
>once you get AST, relay use it to DIFF/ SPLIT/ Defer/PRINT  ==> request
>responst ==> utilze AST to serialize response into store; we effectively use AST to traverse response data and save them into store (RelayQueryWriter.js)
>AST is the `thread`
>once serialization is done, we notify RelayContainers that data is ready, they then call _getQueryData which is another traversal using query AST
>(readRelayQueryData.js)

# How is RelayQuery sent to server?
  RelayContainer build the raw querySet => pass the relayEnvironment.primeCache => graphqlQueryRunner.runQueries{

```
graphqlQueryRunner.runQueries{

      storeData.getTaskQueue().enqueue(function () {
      var queries = [];
      if (fetchMode === require('./RelayFetchMode').CLIENT) {
        require('fbjs/lib/forEachObject')(querySet, function (query) {
          if (query) {
            var diffedQuery = require('./diffRelayQuery')(query, storeData.getRecordStore(), storeData.getQueryTracker())
            queries.push.apply(queries, diffedQuery);
          }
        });


          const flattenedQueries = splitAndFlattenQueries(storeData, queries);
          // tell everyone that $ajax.send is about to start!!
              const networkEvent = [];
              if (flattenedQueries.length) {
                networkEvent.push({type: 'NETWORK_QUERY_START'});  
              }

          //call $ajax.send() . the main `promise-then chain`
              flattenedQueries.forEach(query => {
                const pendingFetch = storeData.getPendingQueryTracker().add(
                  {query, fetchMode, forceIndex, storeData}
                );
                const queryID = query.getID();
                remainingFetchMap[queryID] = pendingFetch;
                if (!query.isDeferred()) {
                  remainingRequiredFetchMap[queryID] = pendingFetch;
                }
          //************************************************************************************** */
          //************************************************************************************** */
                //this is ajax main promise-then chain
                //$ajax.send().then( response=>onResolved, error=>onRjected)
                pendingFetch.getResolvedPromise().then(
                  onResolved.bind(null, pendingFetch), `NETWORK_QUERY_RECEIVED_ALL`
                  onRejected.bind(null, pendingFetch)  `NETWORK_QUERY_ERROR`
                );
          //************************************************************************************** */
          //************************************************************************************** */                
              });
         
          }
      }
}
```

# store/RelayEnvironment  is pivotal
   `RelayEnvironment` is the public API for Relay core

`RelayEnvironment`
  + RelayStoreData
        +  _queuedStore: RelayRecordStore;
        +  _recordStore: RelayRecordStore;
        +  _cachedStore: RelayRecordStore;
        +  _queryTracker
        +  _networkLayer
  + ApplyUpdate
  + CommitUpdate
  + primeCache
  + forceFetch
  + mutation stuff
```  
class RelayStoreData {
//********************************************************************/
  //I have 3 record store; one for records, one for queued records (optimistic updates), and one for cached record
  //  An optimistic mutation is going to immediately store a value in queuedRecords 
  //  every component watching that object is going to be updated to the queued/optimistic result. 
  // The object in the queued store also gets marked with a mutation id. 
  // When the mutation finally completes the record store is updated and the queued store value – which was marked with the mutation id – is deleted.
  // http://hueypetersen.com/posts/2015/09/30/quick-look-at-the-relay-store/
  // "As far as the cached store … I have no idea."   Huey Petersen  eyston
  _records: store;
  _queuedRecords: store;
  _cachedRecords: store;

  _queuedStore: RelayRecordStore;
  _recordStore: RelayRecordStore;
  _cachedStore: RelayRecordStore;

  _queryTracker: ?RelayQueryTracker;
  _queryRunner: GraphQLQueryRunner;
//********************************************************************/
```
# __storagekey__
Relay use __storagekey__ to determine whether it has fetched the data before or not
`__storageKey == this.getSchemaName() + this.getCallsWithValues().filter(para=>_isCoreArg(para))`


Given a query 
```
fragment on Store{
  Person(dummy:'some-data-from-parent',status:'passed'){
    id,
    name,
    age
  }
  
  `
```
`diffRelayQuery` will workout `__storageKey__` nodes for the query AST and look up store for that  `__storagekey__`
For the first time Relay can't find the record, so `diffRelayQuery` returns diffNode and that diffNode gets sent to server
after server responded with data, Relay update store with 
```
_records{

  Person:2 {   
    __dataID__:'Person:2',
    __typename:'Person'
    age:32,
    id:'Person:2',
    status:'passed'
  }

  Store: 1 {  //this is actually a merged result of query #1 and query #
    __dataID__:'Store:1', //used to build node query
    __typename:'Store',
    counter:10, // from query#1
    country_code:'cn',   //from query#2
    id:'Store:1',
    Person{dummy:'some-data-from-parent',status:'passed'}{      // !! this is the __storagekey__ we are talking about !!
        __dataID__:'Person2"
    }

  }
}
```

E:\relay-digest\query\RelayQuery.js, line 1335
```
//************************************************************************************ */
  /**
   * The name which Relay internals can use to reference this field, without
   * collisions.
   *
   * Given the GraphQL
   *   `field(first: 10, foo: "bar", baz: "bat")`, or
   *   `field(baz: "bat", foo: "bar", first: 10)`
   *
   * ...the following storage key will be produced:
   *   `'field{bar:"bat",foo:"bar"}'`
   */
  getStorageKey(): string {
    let storageKey = this.__storageKey__;
    if (!storageKey) {
      this.__storageKey__ = storageKey =
        this.getSchemaName() +
        serializeCalls(
          this.getCallsWithValues().filter(call => this._isCoreArg(call))
        );
    }
    return storageKey;
  }
//************************************************************************************ */
```

# digest
## why relay?
Note two important benefits in the GraphQL version:

All data is fetched in a single round trip.
The client and server are decoupled: the client specifies the data needed instead of relying on the server endpoint to return the correct data.

## queued records, records, and cached records?

Cache Consistency 
With GraphQL it is very common for the results of multiple queries to overlap. However, our response cache from the previous section doesn't account for this overlap — it caches based on distinct queries. For example, if we issue a query to fetch stories:

query { stories { id, text, likeCount } }
and then later refetch one of the stories whose likeCount has since been incremented:

query { story(id: "123") { id, text, likeCount } }
We'll now see different likeCounts depending on how the story is accessed. A view that uses the first query will see an outdated count, while a view using the second query will see the updated count.

## View and Model
Achieving View Consistency 
The approach that Relay takes is to maintain a mapping from each UI view to the set of IDs it references. In this case, the story view would subscribe to updates on the story (1), the author (2), and the comments (3 and any others). When writing data into the cache, Relay tracks which IDs are affected and notifies only the views that are subscribed to those IDs. The affected views re-render, and unaffected views opt-out of re-rendering for better performance (Relay provides a safe but effective default shouldComponentUpdate). Without this strategy, every view would re-render for even the tiniest change.


## Think in Relay

In our experience, the overwhelming majority of products want one specific behavior: fetch all the data for a view hierarchy while displaying a loading indicator, and then render the entire view once the data is ready.

1. One solution is to have a root component fetch the data for all its children. However, this would introduce coupling: every change to a component would require changing any root component that might render it, and often some components between it and the root. This coupling could mean a greater chance for bugs and slow the pace of development. Ultimately, this approach doesn't take advantage of React's component model. The natural place for specifying data-dependencies was in components.

2. The next logical approach is to use render() as the means of initiating data-fetching. We could simply render the application once, see what data it needed, fetch that data, and render again. This sounds great, but the problem is that components use data to figure out what to render! In other words, this would force data-fetching to be staged: first render the root and see what data it needs, then render its children and see what they need, all the way down the tree. If each stage incurs network request, rendering would require slow, serial roundtrips. We needed a way to determine all the data needs up-front or statically.

3. We ultimately settled on static methods; components would effectively return a query-tree, separate from the view-tree, describing their data dependencies. Relay could then use this query-tree to fetch all the information needed in a single stage and use it to render the components. The problem was finding an appropriate mechanism to describe the query-tree, and a way to efficiently fetch it from the server (i.e. in a single network request). This is the perfect use-case for GraphQL because it provides a syntax for describing data-dependencies as data, without dictating any particular API. Note that Promises and Observables are often suggested as alternatives, but they represent opaque commands and preclude various optimizations such as query batching.

# How did we get here?
## remove test files
```
git rm __mocks__ -r
git rm __tests__ -r
git rm */__mocks__ -r
git rm */__tests__ -r
git rm */*/__mocks__ -r
git rm */*/__tests__ -r
```

## change to *.ts  => then changed it back becuase Realy was using JS with Flow, not TypeScript
```
bo1014240@IPP-LTP-6274DJL MINGW64 D:/relay-digest (master)
boche1@UNISYDWS065 MINGW64 /e/relay-digest (master)
$ for f in */*.ts; do mv "$f" "${f%.ts}.js";  done

boche1@UNISYDWS065 MINGW64 /e/relay-digest (master)
$ for f in */*/*.ts; do mv "$f" "${f%.ts}.js";  done

```

