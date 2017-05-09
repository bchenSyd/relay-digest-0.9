# `Relay Deep Dive` by Greg Hurrell
## process
```
schema.json -> babel-relay-plugin -> Relay.QL`query{ rootQuery}` --> query AST
Diff with Store data (_diffScalar)  --> Split ( RelayQueryTransform, traverse the query ) -> print (graphQL server doesn't speak AST)
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

## Traversal : RelayQueryVisitor (read version, base Class)
```
    RelayQueryTransform (read-write version, for SPLITTING, Deferring..etc. transform graphql Query and send to server)
    RelayQueryWrite : read version; utilize AST to pluck responsedata (POJO) and save into _recordStore
    readRelayQueryData : read version; traverse(node, nextState)  use nextState to hold returned data (magnetic)
                        for RelayContainer to get response data from store using AST as key
```
### Tree
>AST is the most important thing in relay; it participate in the entire process of request lifecycle
>you first write query in graphql , which is string; then babel-relay plug in parse that into AST
>once you get AST, relay uses it to DIFF/ SPLIT/ Defer/PRINT  ==> request
>responst ==> utilze AST to serialize response into store; we effectively use AST to traverse response data and save them into store (RelayQueryWriter.js)
>once serialization is done, we notify RelayContainers that data is ready, they then call _getQueryData which is another traversal using query AST
>(readRelayQueryData.js)

# How is RelayQuery sent to server? the main loop / request chain
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

          //call $ajax.send() . the main `promise-then chain` /loop
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
                  onResolved.bind(null, pendingFetch),  //see graphqlQueryRunner, line 144 (same file)  `NETWORK_QUERY_RECEIVED_ALL`
                  onRejected.bind(null, pendingFetch)   // same file, line 177,                         `NETWORK_QUERY_ERROR`
                );
          //************************************************************************************** */
          //************************************************************************************** */                
              });
         
          }
      }
}
```

# RelayEnvironment  is pivotal
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

# Relay Store  
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
# when debugging `RelayContainer`, how do I know which wrapped react component I'm working on?
`Relaycontainer` has `  var componentName = getComponentName(Component);` in line 104 (compiled code line 54) which store the wrapped component. However, that's usally not availble due to optimization
the practical approach of figuring out the wrapped react component is via relay fragment --- we can use fragment as the unique identifier of react component
just check  `this._fragmentPointers-> ... -> fragment -> __concreteNode__ -> name`. It normally contains data like "MobileNavigationBar_ViewerRelayQL" which tells you which component it's wrapping


# recordID,  __storagekey__  and  trackedQuery

## recordID is the id field of an object, it's the unique identifier for an object

## __storagekey__ is the record store path. e.g.
```
Relay.Query`query{
   viewer{
      events(id:$id) {
         meeting{
           name,
           id
         }}
  }`
```
will result into 
-------------------------------------------------------------------------------------------------------------------
viewer                  (this is the stroage key)              __dataID__ : 'client:-21347635687'
   events{id:'0:91430'} (this is the stroage key)                  __dataID__: 'event:91430'
          meeting       (this is the stroage key)                      __dataID__: 'meeting:aus_t_28_02_2017'
               id       (this is the stroage key)                                 'meeting:aus_t_28_02_2017'
               name     (this is the stroage key)                                  'bendigo'
-------------------------------------------------------------------------------------------------------------------
`Relay` uses __storageKey__ to diff query against recordStore and only fetchs data that doesn't exist on recordStore

## trackedQuery is a map of {recordIDs: [AST1, AST2, AST3]. it's used to calculate `fields refetch` after a mutation


>Relay uses __storagekey__ to determine whether it has fetched the data before or not
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

`tracked query` is created when Relay has got the query payload and start writing data into store. I think its used for `mutaton`.
 1. keep a record of all raw ASTs that bring in this <Object> record. so that we know what `fields` has been queried on this `object field` 
 2. intersect the fat query of a mutation, to workout what `fields` need to `refetch`

# the save response data into store traverse
```
RelayQueryTracker             trackNodeForID
//D:\__work\relay-digest\store\RelayQueryWriter.js line:659
RelayQueryWriter              1. createRecordIfMissing, note down new __dataID__ as nextLinkID 
                              2. Store:1.person{status:"in_progress"} = Person:2  
                              recordId.storageKey = nextLinkedId (putLinkedRecordID(recordID, storageKey, nextLinkedID) )
RelayQueryWriter              visitRoot
RelayQueryWriter              visit
RelayQueryWriter              writePayload
WriteRelayQueryPayload        WriteRelayQueryPayload ===> var dataID = void 0; dataID = result[ID] //use the id field defined in Graphql Node interface
RelayStoreData                handleQueryPayload
RelayTaskQueue                enqueue
RelayPendingQueryTracker.js   _handleQuerySuccess

```

## storage key algorithm
```
source: E:\relay-digest\query\RelayQuery.js, line 1335
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



# Think in Relay

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

## component `SearchContainer` was rendered with variables that differ from the variables used to fetch fragment `viewer`. The fragment was fetched with variables `{"status":"null"}`, but rendered with variables `{"status":"passed"}`
query -> field ->fragment->field->fragment->filed.....      __path__ contains the hierachy, see section ## about __path__ below

call stack:
```
throw 'RelayContainer: component A was rendered with varialbes xx that differ from the variables used to fetch..'
RelayContainer.validateFragmentProp // if not in production
RelayContainer.getfragment   //getfragment then calls `buildContainerFragment` to build a fragment AST
RelayContainer._updateFragmentPointers
RelayContainer._initialize
```

what it is saying is that: 1. I've a fragment with `variables#rendered` (seeing is believing) which was set via this.props.relay.setVariables({...updatedVars})),
                              and can be retrieved by `fragment.getVariables()`;
                           2. My parent passed me a field( where my fragment is defined in. i.e. the 'container'), with variables
                              `variables#fetched` set via `Fragement Override (react props)`, and can be retrieved by 
                              `RelayFragmentPointer.getFragmentVariables(prop /*indicates parent*/, fragment)`. e.g.
viewer:{ 
  __dataId__:'client:1234',  //the field object fragent is defined on
  counter:10,   //fileds that my parent has queried; shouldn't pass to me as I didn't ask for it
  name:'bchen'  //would be nice if we can filter these properties out when passing containing field to child 
  __fragments__: Object
      1::client   //this is what `$childContainer1.getFragment('viewer',varialbes)` gets resolved into from Parent container
      2::client   //this is what `$childContainer2.getFragment('viewer',varialbes)` gets resolved into from Parent container
      3::client   //this is what `$childContainer2.getFragment('viewer',varialbes)` gets resolved into from Parent container
  }

```
 RelayFragmentPointer. getFragmentVariables: function getFragmentVariables(prop /*the field passed from parent*/, fragment) {
    var fragmentMap = prop.__fragments__; // field in parent contains all fragments defined under it
    if (typeof fragmentMap === 'object' && fragmentMap != null) {
      var _fragmentID2 = fragment.getConcreteFragmentID(); // what is MY fragment id? AST node id often 1::client / d::client ...etc (this.__concreteNode__.id;)
      return fragmentMap[_fragmentID2]; // fragementMap **only** contains variables
    }
    return null;
  },
```

I'm trying to build up my fragmentPointer so that I can use it to retreive data from store( only I can do that my spec is opaque to my parent).
After I've built up my fragmentPointer, since i'm not in production, it's always nice to check if my fragment is 'client:1234.2::client' (i.e. do they match?)
in case I can't find the fragment from fragment-container (if(!hasFragmentData){ throw warning}).
```
Here is variables#render that is about to be used to render (_getQueryData);
and here is variables#fetch which was passed from parent
```
Once `Relay` gets response from server, it notifies either RelayRenderer(first load) or corresponding RelayContainer that data is ready; RelayRenderer or RelayContainer will then query data from relay store. The 'token' they use to fetch data is their fragmentPointer, i.e. the relay spec (each RelayContainer has a Relay Fragment)
```
  RelayContainer.prototype._getQueryData = function _getQueryData(props) 
  {
     var fragmentPointers = this._fragmentPointers;
     foreach(fragment in fragments){
        fragmentResolver.resolve(fragmentPointer.fragment, fragmentPointer.dataIDs) //dataIDs is parent fragment dataID. it's normally something like 'client:14578962'                                                                                  //becuase the root viewer field doesn't have a server id (a singleton in most cases)
     })
  }
```
the problem is that if you don't pass override variable to `RelayContainer`, the fragmentPointer.framgment still refer to the old QueryVariables. why is the case?
to figure out why we need to undrestand how fragmentPointer.fragment is built. It's actually gets built up in ` _updateFragmentPointers`  during `_initialize`, which means, everytime your `RelayContainer` gets re-rendered, the fragmentPointers get get rebuilt. 
```

RelayContainer.js , source code line:574
//ComponentDidMount -> setState -> _initialize -> updateFragmentPointers -> validateFragmentProp -> variables used to fetch differs from variables used to render
  _initialize(
      props: Object,
      context: RelayContainerContext,
      propVariables: Variables,
      prevVariables: ?Variables
    ): {
        Component  if you are using mock data, ignore this warning
              this._updateFragmentPointers(
                props,
                context,
                nextVariables,  // #fetch version, RelayFragmentPointer version, null version
                prevVariables
              );
    }

    ....
    setVarialbes({xxx}) // #render version, fragment.getVariables version, non-null version

```

## about __path__
I reckon that   __path__ is used to pass (fragment containing field ) from parent container   to child container
   __path__ contains the hierachy

```
client:12919406  //root field
    __path__: RelayQueryRoot
        type:'root'
        __children__:Array[RelqyQueryField|RelayQueryFragment]
              0:RelayQueryField
                  __children: array
                      0:field
                      1:fragment
                      2:fragment
              1:RelayQueryFragment
                  __children__: array
                          0: field
                          1: field
                              __children: array \ 0:field 1: fragment 2: fragment...
                          2: fragment
```
