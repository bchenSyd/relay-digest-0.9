# digest
## why relay?
Note two important benefits in the GraphQL version:

All data is fetched in a single round trip.
The client and server are decoupled: the client specifies the data needed instead of relying on the server endpoint to return the correct data.
## queued records, records, and cached records?
### issue
Cache Consistency 
With GraphQL it is very common for the results of multiple queries to overlap. However, our response cache from the previous section doesn't account for this overlap — it caches based on distinct queries. For example, if we issue a query to fetch stories:

query { stories { id, text, likeCount } }
and then later refetch one of the stories whose likeCount has since been incremented:

query { story(id: "123") { id, text, likeCount } }
We'll now see different likeCounts depending on how the story is accessed. A view that uses the first query will see an outdated count, while a view using the second query will see the updated count.

### solution
```
type record = {
   DATAID:{
       field1: value,
       field2: value,
       field3: value,
       field4: value,
       field5: value,
       field6: Link(record)  //cyclic link is supported
   }
}

type recordStore = Array[record] // normalized and stored into a flat collection of records
                                 // With this approach each server record is stored once
                                 // regardless of how it is fetched.
type relayStore ={
    queueRecords: recordStore,
    records: recordStore,
    cachedRecords: recordStore
}


-------------------------------------
example 1 :
query {
  story(id: "1") {
    text,
    author {
      name
    }
  }
}

data: {
  story: {
     text: "Relay is open-source!",
     author: {
       name: "Jan"
     }
  }
}

Map {
  // `story(id: "1")`
  1: Map {
    text: 'Relay is open-source!',
    author: Link(2),
  },
  // `story.author`
  2: Map {
    name: 'Jan',
  },
};
---------------------------
example 2:
query {
  node(id: "1") {
    text,
    author { name, photo },
    comments {
      text,
      author { name, photo }
    }
  }
}

Map {
  // `story(id: "1")`
  1: Map {
    author: Link(2),
    comments: [Link(3)],
  },
  // `story.author`
  2: Map {
    name: 'Yuzhi',
    photo: 'http://.../photo1.jpg',
  },
  // `story.comments[0]`
  3: Map {
    author: Link(2),
  },
}
```
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

## change to *.ts
```
bo1014240@IPP-LTP-6274DJL MINGW64 D:/relay-digest (master)
$ for f in */*.js; do mv -- "$f" "${f%.js}.ts";  done     #first layer
$ for f in */*/*.js; do mv -- "$f" "${f%.js}.ts";  done   #nested layer
```

