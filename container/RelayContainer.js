/* key info:
  1. onReadyStateChange  : callback for the rootQuery
  2. _handleFragmentDataUpdate : callback for mutations
*/
'use strict';

const ErrorUtils = require('ErrorUtils');
const React = require('React');
const RelayContainerComparators = require('RelayContainerComparators');
const RelayContainerProxy = require('RelayContainerProxy');
const RelayFragmentPointer = require('RelayFragmentPointer');
const RelayFragmentReference = require('RelayFragmentReference');
const RelayMetaRoute = require('RelayMetaRoute');
const RelayMutationTransaction = require('RelayMutationTransaction');
const RelayProfiler = require('RelayProfiler');
const RelayPropTypes = require('RelayPropTypes');
const RelayQuery = require('RelayQuery');
const RelayRecord = require('RelayRecord');
const RelayRecordStatusMap = require('RelayRecordStatusMap');

const areEqual = require('areEqual');
const buildRQL = require('buildRQL');
const filterObject = require('filterObject');
const forEachObject = require('forEachObject');
const invariant = require('invariant');
const isLegacyRelayContext = require('isLegacyRelayContext');
const relayUnstableBatchedUpdates = require('relayUnstableBatchedUpdates');
const shallowEqual = require('shallowEqual');
const warning = require('warning');

const {getComponentName, getReactComponent} = require('RelayContainerUtils');

import type {ConcreteFragment} from 'ConcreteQuery';
import type {FragmentResolver, LegacyRelayContext} require('../store/RelayEnvironment');
import type {DataID, RelayQuerySet} from 'RelayInternalTypes';
import type {RelayQueryConfigInterface} from 'RelayQueryConfig';
import type {
  Abortable,
  ComponentReadyStateChangeCallback,
  RelayContainer as RelayContainerClass,
  RelayProp,
  Variables,
} from 'RelayTypes';
import type {RelayQLFragmentBuilder} from 'buildRQL';

type FragmentPointer = {
  fragment: RelayQuery.Fragment,
  dataIDs: DataID | Array<DataID>
};
type RelayContainerContext = {
  relay: LegacyRelayContext,
  route: RelayQueryConfigInterface,
  useFakeData: boolean,
};

export type RelayContainerSpec = {
  fragments: {
    [propName: string]: RelayQLFragmentBuilder
  },
  initialVariables?: Variables,
  prepareVariables?: (
    prevVariables: Variables,
    route: RelayMetaRoute
  ) => Variables,
  shouldComponentUpdate?: () => boolean,
};
export type RelayLazyContainer = Function;

const containerContextTypes = {
  relay: RelayPropTypes.LegacyRelay,
  route: RelayPropTypes.QueryConfig.isRequired,
  useFakeData: React.PropTypes.bool,
};

/**
 * @public
 *
 * RelayContainer is a higher order component that provides the ability to:
 *
 *  - Encode data dependencies using query fragments that are parameterized by
 *    routes and variables.
 *  - Manipulate variables via methods on `this.props.relay`.
 *  - Automatically subscribe to data changes.
 *  - Avoid unnecessary updates if data is unchanged.
 *  - Propagate the `route` via context (available on `this.props.relay`).
 *
 */
function createContainerComponent(
  Component: ReactClass<any>,
  spec: RelayContainerSpec
): RelayContainerClass {
  const ComponentClass = getReactComponent(Component);
  const componentName = getComponentName(Component);
  const containerName = getContainerName(Component);
  const fragments = spec.fragments;
  const fragmentNames = Object.keys(fragments);
  const initialVariables = spec.initialVariables || {};
  const prepareVariables = spec.prepareVariables;
  const specShouldComponentUpdate = spec.shouldComponentUpdate;

  class RelayContainer extends React.Component {
    mounted: boolean;
    _didShowFakeDataWarning: boolean;
    _fragmentPointers: {[key: string]: ?FragmentPointer};
    _hasStaleQueryData: boolean;
//***********************************************************************************/
//each fragment defined within the React Component will have a fragmentResolver allocated for it
// all kept within _fragmentResolvers list;
//e.g. _fragmentResolvers : {person: GraphQLStoreQueryResolver}
       _fragmentResolvers: {[key: string]: ?FragmentResolver};
//***********************************************************************************/


    pending: ?{
      rawVariables: Variables,
      request: Abortable,
    };

    state: {
      queryData: {[propName: string]: mixed},
      rawVariables: Variables,
      relayProp: RelayProp,
    };

    constructor(props, context) {
      super(props, context);

      const {relay, route} = context;
      invariant(
        isLegacyRelayContext(relay),
        'RelayContainer: `%s` was rendered with invalid Relay context `%s`. ' +
        'Make sure the `relay` property on the React context conforms to the ' +
        '`RelayEnvironment` interface.',
        containerName,
        relay
      );
      invariant(
        route && typeof route.name === 'string',
        'RelayContainer: `%s` was rendered without a valid route. Make sure ' +
        'the route is valid, and make sure that it is correctly set on the ' +
        'parent component\'s context (e.g. using <RelayRootContainer>).',
        containerName
      );

      this._didShowFakeDataWarning = false;
      this._fragmentPointers = {};
      this._hasStaleQueryData = false;
      this._fragmentResolvers = {};

      this.mounted = true;
      this.pending = null;
      this.state = {
        queryData: {},
        rawVariables: {},
        relayProp: {
          applyUpdate: this.context.relay.environment.applyUpdate,
          commitUpdate: this.context.relay.environment.commitUpdate,
          forceFetch: this.forceFetch.bind(this),
          getPendingTransactions: this.getPendingTransactions.bind(this),
          hasFragmentData: this.hasFragmentData.bind(this),
          hasOptimisticUpdate: this.hasOptimisticUpdate.bind(this),
          hasPartialData: this.hasPartialData.bind(this),
          pendingVariables: null,
          route,
          setVariables: this.setVariables.bind(this),
          variables: {},
        },
      };
    }

    /**
     * Requests an update to variables. This primes the cache for the new
     * variables and notifies the caller of changes via the callback. As data
     * becomes ready, the component will be updated.
     */
    setVariables(
      partialVariables?: ?Variables,
      callback?: ?ComponentReadyStateChangeCallback
    ): void {
      this._runVariables(partialVariables, callback, false);
    }

    /**
     * Requests an update to variables. Unlike `setVariables`, this forces data
     * to be fetched and written for the supplied variables. Any data that
     * previously satisfied the queries will be overwritten.
     */
    forceFetch(
      partialVariables?: ?Variables,
      callback?: ?ComponentReadyStateChangeCallback
    ): void {
      this._runVariables(partialVariables, callback, true);
    }

    /**
     * Creates a query for each of the component's fragments using the given
     * variables, and fragment pointers that can be used to resolve the results
     * of those queries. The fragment pointers are of the same shape as the
     * `_fragmentPointers` property.
     */
    _createQuerySetAndFragmentPointers(variables: Variables): {
      fragmentPointers: {[key: string]: ?FragmentPointer},
      querySet: RelayQuerySet,
    } {
      const fragmentPointers = {};
      const querySet = {};
      const storeData = this.context.relay.environment.getStoreData();
      fragmentNames.forEach(fragmentName => {
        const fragment =
          getFragment(fragmentName, this.context.route, variables);
        const queryData = this.state.queryData[fragmentName];
        if (!fragment || queryData == null) {
          return;
        }

        let fragmentPointer;
        if (fragment.isPlural()) {
          invariant(
            Array.isArray(queryData),
            'RelayContainer: Invalid queryData for `%s`, expected an array ' +
            'of records because the corresponding fragment is plural.',
            fragmentName
          );
          const dataIDs = [];
          queryData.forEach((data, ii) => {
            /* $FlowFixMe(>=0.36.0) Flow error detected
             * during the deploy of Flow v0.36.0. To see the error, remove this
             * comment and run Flow */
            const dataID = RelayRecord.getDataIDForObject(data);
            if (dataID) {
              querySet[fragmentName + ii] =
                storeData.buildFragmentQueryForDataID(fragment, dataID);
              dataIDs.push(dataID);
            }
          });
          if (dataIDs.length) {
            fragmentPointer = {fragment, dataIDs};
          }
        } else {
          /* $FlowFixMe(>=0.19.0) - queryData is mixed but getID expects Object
           */
          const dataID = RelayRecord.getDataIDForObject(queryData);
          if (dataID) {
            fragmentPointer = {
              fragment,
              dataIDs: dataID,
            };
            querySet[fragmentName] =
              storeData.buildFragmentQueryForDataID(fragment, dataID);
          }
        }

        fragmentPointers[fragmentName] = fragmentPointer;
      });
      return {fragmentPointers, querySet};
    }

    _runVariables(
      partialVariables: ?Variables,
      callback: ?ComponentReadyStateChangeCallback,
      forceFetch: boolean
    ): void {
      validateVariables(initialVariables, partialVariables);
      const lastVariables = this.state.rawVariables;
      const prevVariables =
        this.pending ? this.pending.rawVariables : lastVariables;
      const rawVariables = mergeVariables(prevVariables, partialVariables);
      let nextVariables = rawVariables;
      if (prepareVariables) {
        const metaRoute = RelayMetaRoute.get(this.context.route.name);
        nextVariables = prepareVariables(rawVariables, metaRoute);
        validateVariables(initialVariables, nextVariables);
      }

      this.pending && this.pending.request.abort();

      const completeProfiler = RelayProfiler.profile(
        'RelayContainer.setVariables', {
          containerName,
          nextVariables,
        }
      );

      // Because the pending fetch is always canceled, we need to build a new
      // set of queries that includes the updated variables and initiate a new
      // fetch.
      const {querySet, fragmentPointers} =
        this._createQuerySetAndFragmentPointers(nextVariables);


//   bchen  gut of the system; graphql query runner, graphqlQueryRunner; initial load; dataready; critical info; mutation;
//   Note: 重要 
//   第一:  this is ONLY for queries, namely rootQuery (initQuery) and following queries triggered by relay.setVariables ; 
//   we come here after GraphQLQueryRunner;
//   第二: for mutations, it's through a different channel which is _handleFragmentDataUpdate; the invokation path is: 
//   mutation --> relayStore change -> store notify subscribers (search _processSubscriber) -> RelayContainer._handleFragmentDataUpdate
//   #see how relay store notify its subscribers after a change at legacy/store/GraphQLStoreChangeEmitter.js::_processSubscriber


//   registered in environment.primeCache (querySet, this.onReadyStateChange){  this._storeData.getQueryRunner().run(querySet, this.onReadyStateChange : callback); }
      const onReadyStateChange = ErrorUtils.guard(readyState => {
        const {aborted, done, error, ready} = readyState;
        const isComplete = aborted || done || error;
        if (isComplete && this.pending === current) {
          this.pending = null;
        }
        let partialState;
        if (ready) {
          // Only update query data if variables changed. Otherwise, `querySet`
          // and `fragmentPointers` will be empty, and `nextVariables` will be
          // equal to `lastVariables`.
          this._fragmentPointers = fragmentPointers;
          this._updateFragmentResolvers(this.context.relay.environment);
          const queryData = this._getQueryData(this.props);
          partialState = {
            queryData,
            rawVariables,
            relayProp: {
              ...this.state.relayProp,
              pendingVariables: null,
              variables: nextVariables,
            },
          };
        } else {
          partialState = {
            relayProp: {
              ...this.state.relayProp,
              pendingVariables: isComplete ? null : nextVariables,
            },
          };
        }
        const mounted = this.mounted;
        if (mounted) {
          const updateProfiler = RelayProfiler.profile('RelayContainer.update');
          relayUnstableBatchedUpdates(() => {
            this.setState(partialState, () => {
              updateProfiler.stop();
              if (isComplete) {
                completeProfiler.stop();
              }
            });
            if (callback) {
              callback.call(
                // eslint-disable-next-line react/no-string-refs
                this.refs.component || null,
                {...readyState, mounted}
              );
            }
          });
        } else {
          if (callback) {
            callback({...readyState, mounted});
          }
          if (isComplete) {
            completeProfiler.stop();
          }
        }
      }, 'RelayContainer.onReadyStateChange');


      //  $ajax.send is dispatched here!
      var request = undefined
      if(forceFetch){
          request= this.context.relay.environment.forceFetch(querySet, onReadyStateChange) 
      }else{
          request = this.context.relay.environment.primeCache(querySet, onReadyStateChange)
      }
      const current = {
        rawVariables,
        request
      };
      this.pending = current;
    }

//*********************************************************************************** */
  // hasOptimisticUpdate basically checks relay queuedRecord store, and see if it can find one item there for the given record DataId
  //essentially queuedRecord.hasOwnProperty( reocrd.__dataId__)
  // seach for #buck stops here
    hasOptimisticUpdate(  
      record: Object
    ): boolean {
      const dataID = RelayRecord.getDataIDForObject(record);
      invariant(
        dataID != null,
        'RelayContainer.hasOptimisticUpdate(): Expected a record in `%s`.',
        componentName
      );
      return this.context.relay.environment.getStoreData().hasOptimisticUpdate(dataID);
    }

    //this pretty much overlaps with hasOptimisticUpdate ; the difference is getPendingTransactions is broader and includes all *INDIRECT* mutations that would impact passed in record
    //the relay document says getPendingTransactions will returns  all the client mutations that *could* impact the passed in record
    //please check  relay-digest\store\RelayRecordStore.js for implementation details
    
    //essentially queuedRecord[reocrd.__dataId__]  => NULL or Array<client_muation_id>()
    getPendingTransactions(record: Object): ?Array<RelayMutationTransaction> {
      const dataID = RelayRecord.getDataIDForObject(record); 
      invariant(
        dataID != null,
        'RelayContainer.getPendingTransactions(): Expected a record in `%s`.',
        componentName
      );      
      const storeData = this.context.relay.environment.getStoreData();


       //getPendingTransactions will essentially call  RelayStoreData.getClientMutationIDs for the final result
      //******************************************************** */
      const mutationIDs = storeData.getClientMutationIDs(dataID);  //I'm the KEY!  it only returns none null if optimistic udpate is turned on;
      //******************************************************** */




      if (!mutationIDs) {
        return null;
      }
      const mutationQueue = storeData.getMutationQueue();
      return mutationIDs.map(id => mutationQueue.getTransaction(id)); //transform the result ; flesh it out with more info based on mutation id (client_mutation_id)
    }
//*********************************************************************************** */






    /**
     * Checks if data for a deferred fragment is ready. This method should
     * *always* be called before rendering a child component whose fragment was
     * deferred (unless that child can handle null or missing data).
     */
    hasFragmentData(
      fragmentReference: RelayFragmentReference,
      record: Object
    ): boolean {
      // convert builder -> fragment in order to get the fragment's name
      const dataID = RelayRecord.getDataIDForObject(record);
      invariant(
        dataID != null,
        'RelayContainer.hasFragmentData(): Second argument is not a valid ' +
        'record. For `<%s X={this.props.X} />`, use ' +
        '`this.props.hasFragmentData(%s.getFragment(\'X\'), this.props.X)`.',
        componentName,
        componentName
      );
      const fragment = getDeferredFragment(
        fragmentReference,
        this.context,
        this.state.relayProp.variables
      );
      invariant(
        fragment instanceof RelayQuery.Fragment,
        'RelayContainer.hasFragmentData(): First argument is not a valid ' +
        'fragment. Ensure that there are no failing `if` or `unless` ' +
        'conditions.'
      );
      const storeData = this.context.relay.environment.getStoreData();
      return storeData.getCachedStore().hasFragmentData(
        dataID,
        fragment.getCompositeHash()
      );
    }

    /**
     * Determine if the supplied record might be missing data.
     */
    hasPartialData(
      record: Object
    ): boolean {
      return RelayRecordStatusMap.isPartialStatus(
        record[RelayRecord.MetadataKey.STATUS]
      );
    }

    componentWillMount(): void {
      if (this.context.route.useMockData) {
        return;
      }
      this.setState(
        this._initialize(  // _initialize will call _getQueryData to resolve fragment properties
          this.props,
          this.context,
          initialVariables,
          null
        )
      );
    }

    componentWillReceiveProps(
      nextProps: Object,
      maybeNextContext?: RelayContainerContext
    ): void {
      const nextContext = maybeNextContext;
      invariant(nextContext, 'RelayContainer: Expected a context to be set.');
      if (nextContext.route.useMockData) {
        return;
      }
      this.setState(state => {
        if (this.context.relay !== nextContext.relay) {
          this._cleanup();
        }
        return this._initialize(
          nextProps,
          nextContext,
          resetPropOverridesForVariables(
            spec,
            nextProps,
            state.rawVariables
          ),
          state.rawVariables
        );
      });
    }

    componentWillUnmount(): void {
      this._cleanup();
      this.mounted = false;
    }

    _initialize(
      props: Object,
      context: RelayContainerContext,
      propVariables: Variables,
      prevVariables: ?Variables
    ): {
      queryData: {[propName: string]: mixed},
      rawVariables: Variables,
      relayProp: RelayProp,
    } {
      const rawVariables = getVariablesWithPropOverrides(
        spec,
        props,
        propVariables
      );
      let nextVariables = rawVariables;
      if (prepareVariables) {
        // TODO: Allow routes without names, #7856965.
        const metaRoute = RelayMetaRoute.get(context.route.name);
        nextVariables = prepareVariables(rawVariables, metaRoute);
        validateVariables(initialVariables, nextVariables);
      }
      
      //ComponentDidMount -> setState -> _initialize -> updateFragmentPointers -> validateFragmentProp -> declared fragment isn't passed from parent React Component
      //if you are using mock data, #ignore this warning
      this._updateFragmentPointers(
        props,
        context,
        nextVariables,
        prevVariables
      );


      this._updateFragmentResolvers(context.relay.environment);
      return {
        queryData: this._getQueryData(props),
        rawVariables,
        relayProp: (this.state.relayProp.route === context.route)
          && shallowEqual(this.state.relayProp.variables, nextVariables) ?
          this.state.relayProp :
          {
            ...this.state.relayProp,
            route: context.route,
            variables: nextVariables,
          },
      };
    }

    _cleanup(): void {
      // A guarded error in mounting might prevent initialization of resolvers.
      if (this._fragmentResolvers) {
        forEachObject(
          this._fragmentResolvers,
          fragmentResolver => fragmentResolver && fragmentResolver.dispose()
        );
      }

      this._fragmentPointers = {};
      this._fragmentResolvers = {};

      const pending = this.pending;
      if (pending) {
        pending.request.abort();
        this.pending = null;
      }
    }
  
  /// build up fragmentResolve for each __fragment__ it contains
    _updateFragmentResolvers(environment): void {
      const fragmentPointers = this._fragmentPointers;
      const fragmentResolvers = this._fragmentResolvers;
      fragmentNames.forEach(fragmentName => {
        const fragmentPointer = fragmentPointers[fragmentName];
        let fragmentResolver = fragmentResolvers[fragmentName];
        if (!fragmentPointer) {
          if (fragmentResolver) {
            fragmentResolver.dispose();
            fragmentResolvers[fragmentName] = null;
          }
        } 
        //this is how Hight Order Component register itself for Relay store change; 
        //and once relay store changes, HOC will re-render itself;
        else if (!fragmentResolver) {
          fragmentResolver = environment.getFragmentResolver(
            fragmentPointer.fragment,
            this._handleFragmentDataUpdate.bind(this)   //register callback for relay store change  ===>   this.store.subscribe (this._handleFragmentDataUpdate)
          );

          fragmentResolvers[fragmentName] = fragmentResolver; // see above line of code; the fragmentResolver is retrieved from environment; source of truce
        }
      });
    }


//Query path:
 //  search for: const onReadyStateChange = ErrorUtils.guard(readyState => {
//  Mutation path:
//   for mutations, it's through a different channel which is _handleFragmentDataUpdate; the invokation path is: mutation --> relayStore change -> store notify subscribers -> RelayContainer._handleFragmentDataUpdate
    _handleFragmentDataUpdate(): void {        //storeChange ---> GraphQLStoreChangeEmitter::_processSubscriber -> GraphQLStoreSingleQueryResolver::_handleChange -> this._handleFragmentDataUpdate
      if (!this.mounted) {
        return;
      }
      const queryData = this._getQueryData(this.props);
      const updateProfiler = RelayProfiler.profile(
        'RelayContainer.handleFragmentDataUpdate'
      );
      this.setState({queryData}, updateProfiler.stop);
    }

    _updateFragmentPointers(
      props: Object,
      context: RelayContainerContext,
      variables: Variables,
      prevVariables: ?Variables
    ): void {
      const fragmentPointers = this._fragmentPointers;
      fragmentNames.forEach(fragmentName => {
        const propValue = props[fragmentName];
        warning(
          propValue !== undefined,
          'RelayContainer: Expected prop `%s` to be supplied to `%s`, but ' +
          'got `undefined`. Pass an explicit `null` if this is intentional.',
          fragmentName,
          componentName
        );
        if (propValue == null) {
          fragmentPointers[fragmentName] = null;
          return;
        }
        // handle invalid prop values using a warning at first.
        if (typeof propValue !== 'object') {
          warning(
            false,
            'RelayContainer: Expected prop `%s` supplied to `%s` to be an ' +
            'object, got `%s`.',
            fragmentName,
            componentName,
            propValue
          );
          fragmentPointers[fragmentName] = null;
          return;
        }
        const fragment = getFragment(fragmentName, context.route, variables);
        let dataIDOrIDs;

        if (fragment.isPlural()) {
          // Plural fragments require the prop value to be an array of fragment
          // pointers, which are merged into a single fragment pointer to pass
          // to the query resolver `resolve`.
          invariant(
            Array.isArray(propValue),
            'RelayContainer: Invalid prop `%s` supplied to `%s`, expected an ' +
            'array of records because the corresponding fragment has ' +
            '`@relay(plural: true)`.',
            fragmentName,
            componentName
          );
          if (!propValue.length) {
            // Nothing to observe: pass the empty array through
            fragmentPointers[fragmentName] = null;
            return;
          }
          let dataIDs = null;
          propValue.forEach((item, ii) => {
            if (typeof item === 'object' && item != null) {
              if (RelayFragmentPointer.hasConcreteFragment(item, fragment)) {
                const dataID = RelayRecord.getDataIDForObject(item);
                if (dataID) {
                  dataIDs = dataIDs || [];
                  dataIDs.push(dataID);
                }
              }
              if (__DEV__) {
                if (!context.route.useMockData &&
                    !context.useFakeData &&
                    !this._didShowFakeDataWarning) {


//make sure that the fragment declared within this React Component is referenced/composit in its parent's fragment declaration
//"each component should declare what data they need. not declared by their parents"
                  const isValid = validateFragmentProp(
                    componentName,
                    fragmentName, 
                    fragment,  // ===> fragment is created by calling fragmentBuilder  -- the 2nd parameter passed to createContainer (Relay.createContainer(Component, fragmentBuilder)) 
                    item, //========>  does item -- which is the property passed from parent Component -- has fragment (this component) defined?  if NOT, then it's an anti-pattern/anti pattern, throw warning...
                    prevVariables
                  );



                  this._didShowFakeDataWarning = !isValid;
                }
              }
            }
          });
          if (dataIDs) {
            invariant(
              dataIDs.length === propValue.length,
              'RelayContainer: Invalid prop `%s` supplied to `%s`. Some ' +
              'array items contain data fetched by Relay and some items ' +
              'contain null/mock data.',
              fragmentName,
              componentName
            );
          }
          dataIDOrIDs = dataIDs;
        } else {
          invariant(
             invariant(
            !Array.isArray(propValue),
            'RelayContainer: Invalid prop `%s` supplied to `%s`, expected a ' +
            'single record because the corresponding fragment is not plural ' +
            '(i.e. does not have `relay(plural: true)`).',
            fragmentName,
            componentName
          );
          if (RelayFragmentPointer.hasConcreteFragment(propValue, fragment)) {
            dataIDOrIDs = RelayRecord.getDataIDForObject(propValue);
          }
          if (__DEV__) {
            if (!context.route.useMockData &&
                !context.useFakeData &&
                !this._didShowFakeDataWarning) {
              const isValid = validateFragmentProp(
                componentName,
                fragmentName,
                fragment,
                propValue,
                prevVariables
              );
              this._didShowFakeDataWarning = !isValid;
            }
          }
        }
        fragmentPointers[fragmentName] = dataIDOrIDs ?
          {fragment, dataIDs: dataIDOrIDs} :
          null;
      });
      if (__DEV__) {
        // If a fragment pointer is null, warn if it was found on another prop.
        fragmentNames.forEach(fragmentName => {
          if (fragmentPointers[fragmentName]) {
            return;
          }
          const fragment = getFragment(fragmentName, context.route, variables);
          Object.keys(props).forEach(propName => {
            warning(
              fragmentPointers[propName] ||
              !RelayRecord.isRecord(props[propName]) ||
              typeof props[propName] !== 'object' ||
              props[propName] == null ||
              !RelayFragmentPointer.hasFragment(
                props[propName],
                fragment
              ),
              'RelayContainer: Expected record data for prop `%s` on `%s`, ' +
              'but it was instead on prop `%s`. Did you misspell a prop or ' +
              'pass record data into the wrong prop?',
              fragmentName,
              componentName,
              propName
            );
          });
        });
      }
    }


//   onReadyStateChange  --> ready --> _getQueryData --> this._hasStaleQueryData = true -> shouldComponentUpdate return true -> React Component Re-Render

    _getQueryData(
      props: Object
    ): Object {
      const queryData = {};
      const fragmentPointers = this._fragmentPointers;
      forEachObject(this._fragmentResolvers, (fragmentResolver, propName) => {
        const propValue = props[propName];
        const fragmentPointer = fragmentPointers[propName];

        if (!propValue || !fragmentPointer) {
          // Clear any subscriptions since there is no data.
          fragmentResolver && fragmentResolver.dispose();
          // Allow mock data to pass through without modification.
          queryData[propName] = propValue;
        } else {
          queryData[propName] = fragmentResolver.resolve(  //<-------  update queryData with new fetched data
            fragmentPointer.fragment,
            fragmentPointer.dataIDs
          );
        }
        if (this.state.queryData.hasOwnProperty(propName) &&
            queryData[propName] !== this.state.queryData[propName]) {
          this._hasStaleQueryData = true;  // queryData updated; set _hasStaleQueryData to true, which will cause shouldComponentUpdate return true;
        }
      });
      return queryData;
    }

    shouldComponentUpdate(
      nextProps: Object,
      nextState: any,
      nextContext: any
    ): boolean {
      if (specShouldComponentUpdate) {
        return specShouldComponentUpdate();
      }

     // here if we had _hasStaleQueryData, force update current component, and child will get updated accordingly
     // http://www.webpackbin.com/EJ7Bs8mNM
      if (this._hasStaleQueryData) {
        this._hasStaleQueryData = false;
        return true;
      }
//****************************************************************************************************************************** */
      if (this.context.relay !== nextContext.relay ||
          this.context.route !== nextContext.route) {
        return true;
      }

      const fragmentPointers = this._fragmentPointers;
      return (
        !RelayContainerComparators.areNonQueryPropsEqual(
          fragments,
          this.props,
          nextProps
        ) ||
        (
          fragmentPointers &&
          !RelayContainerComparators.areQueryResultsEqual(
            fragmentPointers,
            this.state.queryData,
            nextState.queryData
          )
        ) ||
        !RelayContainerComparators.areQueryVariablesEqual(
          this.state.relayProp.variables,
          nextState.relayProp.variables
        )
      );
    }

    //
    render(): React.Element<*> {
      if (ComponentClass) {
        return (
          //************************** here is your component  ******************************* */
          <ComponentClass
            //if you component's fragment property doesn't comes from queryData, you get a warning :RelayContainer: component `%s` was rendered with variables ' that differ from the variable
            {...this.props}        //                                                                 this.props <--      {person: { __dataID__ :'xvzfV90==', __fragment__ :{name:'fragmentName'} }}
            {...this.state.queryData}  //  const queryData = this.state.queryData[fragmentName];      this.state.queryData <-- {person:  { __dataID__ :'xvzfV90==', age:34, name:'bchen'}  }
            relay={this.state.relayProp}
            // end this.props
            ref={'component'} // eslint-disable-line react/no-string-refs
          />
        );
      } else {
        // Stateless functional.
        const Fn = (Component: any);
        return React.createElement(Fn, {
          ...this.props,
          ...this.state.queryData,
          relay: this.state.relayProp,
        });
      }
    }
  }

  function getFragment(
    fragmentName: string,
    route: RelayQueryConfigInterface,
    variables: Variables
  ): RelayQuery.Fragment {
    const fragmentBuilder = fragments[fragmentName];
    invariant(
      fragmentBuilder,
      'RelayContainer: Expected `%s` to have a query fragment named `%s`.',
      containerName,
      fragmentName
    );
    const fragment = buildContainerFragment(
      containerName,
      fragmentName,
      fragmentBuilder,
      initialVariables
    );
    // TODO: Allow routes without names, #7856965.
    const metaRoute = RelayMetaRoute.get(route.name);
    return RelayQuery.Fragment.create(
      fragment,
      metaRoute,
      variables
    );
  }

  initializeProfiler(RelayContainer);
  RelayContainer.contextTypes = containerContextTypes;
  RelayContainer.displayName = containerName;
  RelayContainerProxy.proxyMethods(RelayContainer, Component);

  return RelayContainer;
}

/**
 * TODO: Stop allowing props to override variables, #7856288.
 */
function getVariablesWithPropOverrides(
  spec: RelayContainerSpec,
  props: Object,
  variables: Variables
): Variables {
  const initialVariables = spec.initialVariables;
  if (initialVariables) {
    let mergedVariables;
    for (const key in initialVariables) {
      if (key in props) {
        mergedVariables = mergedVariables || {...variables};
        mergedVariables[key] = props[key];
      }
    }
    variables = mergedVariables || variables;
  }
  return variables;
}

/**
 * Compare props and variables and reset the internal query variables if outside
 * query variables change the component.
 *
 * TODO: Stop allowing props to override variables, #7856288.
 */
function resetPropOverridesForVariables(
  spec: RelayContainerSpec,
  props: Object,
  variables: Variables
): Variables {
  const initialVariables = spec.initialVariables;
  for (const key in initialVariables) {
    if (key in props && !areEqual(props[key], variables[key])) {
      return initialVariables;
    }
  }
  return variables;
}

function initializeProfiler(RelayContainer: RelayContainerClass): void {
  RelayProfiler.instrumentMethods(RelayContainer.prototype, {
    componentWillMount:
      'RelayContainer.prototype.componentWillMount',
    componentWillReceiveProps:
      'RelayContainer.prototype.componentWillReceiveProps',
    shouldComponentUpdate:
      'RelayContainer.prototype.shouldComponentUpdate',
  });
}

/**
 * Merges a partial update into a set of variables. If no variables changed, the
 * same object is returned. Otherwise, a new object is returned.
 */
function mergeVariables(
  currentVariables: Variables,
  partialVariables: ?Variables
): Variables {
  if (partialVariables) {
    for (const key in partialVariables) {
      if (currentVariables[key] !== partialVariables[key]) {
        return {...currentVariables, ...partialVariables};
      }
    }
  }
  return currentVariables;
}

/**
 * Wrapper around `buildRQL.Fragment` with contextual error messages.
 */
function buildContainerFragment(
  containerName: string,
  fragmentName: string,
  fragmentBuilder: RelayQLFragmentBuilder,
  variables: Variables
): ConcreteFragment {
  const fragment = buildRQL.Fragment(
    fragmentBuilder,
    variables
  );
  invariant(
    fragment,
    'Relay.QL defined on container `%s` named `%s` is not a valid fragment. ' +
    'A typical fragment is defined using: Relay.QL`fragment on Type {...}`',
    containerName,
    fragmentName
  );
  return fragment;
}

function getDeferredFragment(
  fragmentReference: RelayFragmentReference,
  context: Object,
  variables: Variables
): RelayQuery.Fragment {
  const route = RelayMetaRoute.get(context.route.name);
  const concreteFragment = fragmentReference.getFragment(variables);
  const concreteVariables = fragmentReference.getVariables(route, variables);
  return RelayQuery.Fragment.create(
    concreteFragment,
    route,
    concreteVariables,
    {
      isDeferred: true,
      isContainerFragment: fragmentReference.isContainerFragment(),
      isTypeConditional: false,
    }
  );
}

function validateVariables(
  initialVariables: Variables,
  partialVariables: ?Variables,
): void {
  if (partialVariables) {
    for (const key in partialVariables) {
      warning(
        initialVariables.hasOwnProperty(key),
        'RelayContainer: Expected query variable `%s` to be initialized in ' +
        '`initialVariables`.',
        key
      );
    }
  }
}

function validateSpec(
  componentName: string,
  spec: RelayContainerSpec,
): void {

  const fragments = spec.fragments;
  invariant(
    typeof fragments === 'object' && fragments,
    'Relay.createContainer(%s, ...): Missing `fragments`, which is expected ' +
    'to be an object mapping from `propName` to: () => Relay.QL`...`',
    componentName
  );

  if (!spec.initialVariables) {
    return;
  }
  const initialVariables = spec.initialVariables || {};
  invariant(
    typeof initialVariables === 'object' && initialVariables,
    'Relay.createContainer(%s, ...): Expected `initialVariables` to be an ' +
    'object.',
    componentName
  );

  forEachObject(fragments, (_, name) => {
    warning(
      !initialVariables.hasOwnProperty(name),
      'Relay.createContainer(%s, ...): `%s` is used both as a fragment name ' +
      'and variable name. Please give them unique names.',
      componentName,
      name
    );
  });
}

function getContainerName(Component: ReactClass<any>): string {
  return 'Relay(' + getComponentName(Component) + ')';
}

/**
 * Creates a lazy Relay container. The actual container is created the first
 * time a container is being constructed by React's rendering engine.
 */
function create(
  Component: ReactClass<any>,
  spec: RelayContainerSpec,
): RelayLazyContainer {
  const componentName = getComponentName(Component);
  const containerName = getContainerName(Component);

  validateSpec(componentName, spec);

  const fragments = spec.fragments;
  const fragmentNames = Object.keys(fragments);
  const initialVariables = spec.initialVariables || {};
  const prepareVariables = spec.prepareVariables;

  let Container;
  function ContainerConstructor(props, context) {
    if (!Container) {
      Container = createContainerComponent(Component, spec);
    }
    return new Container(props, context);
  }

  ContainerConstructor.getFragmentNames = () => fragmentNames;
  ContainerConstructor.hasFragment = fragmentName => !!fragments[fragmentName];
  ContainerConstructor.hasVariable = variableName =>
    Object.prototype.hasOwnProperty.call(initialVariables, variableName);

  /**
   * Retrieves a reference to the fragment by name. An optional second argument
   * can be supplied to override the component's default variables.
   */
  ContainerConstructor.getFragment = function(
    fragmentName: string,
    variableMapping?: Variables
  ): RelayFragmentReference {
    const fragmentBuilder = fragments[fragmentName];
    if (!fragmentBuilder) {
      invariant(
        false,
        '%s.getFragment(): `%s` is not a valid fragment name. Available ' +
        'fragments names: %s',
        containerName,
        fragmentName,
        fragmentNames.map(name => '`' + name + '`').join(', ')
      );
    }
    invariant(
      typeof fragmentBuilder === 'function',
      'RelayContainer: Expected `%s.fragments.%s` to be a function returning ' +
      'a fragment. Example: `%s: () => Relay.QL`fragment on ...`',
      containerName,
      fragmentName,
      fragmentName
    );
    if (variableMapping) {
      variableMapping = filterObject(variableMapping, (_, name) =>
        Object.prototype.hasOwnProperty.call(initialVariables, name)
      );
    }
    return RelayFragmentReference.createForContainer(
      () => buildContainerFragment(
        containerName,
        fragmentName,
        fragmentBuilder,
        initialVariables
      ),
      initialVariables,
      variableMapping,
      prepareVariables
    );
  };

  ContainerConstructor.contextTypes = containerContextTypes;
  ContainerConstructor.displayName = containerName;
  ContainerConstructor.moduleName = (null: ?string);

  return ContainerConstructor;
}

/**
 * Returns whether the fragment `prop` contains a fragment pointer for the given
 * fragment's data, warning if it does not.
 */
function validateFragmentProp(
  componentName: string,
  fragmentName: string,
  fragment: RelayQuery.Fragment,
  prop: Object,
  prevVariables: ?Variables
): boolean {
  const hasFragmentData = RelayFragmentPointer.hasFragment(
    prop,
    fragment
  ) || (
    !!prevVariables &&
    areEqual(prevVariables, fragment.getVariables())
  );
  // # ignore this warning 
  if (!hasFragmentData) {
    const variables = fragment.getVariables();
    const fetchedVariables = RelayFragmentPointer.getFragmentVariables(
      prop,
      fragment
    );
    warning(
      false,
      'RelayContainer: component `%s` was rendered with variables ' +
      'that differ from the variables used to fetch fragment ' +
      '`%s`. The fragment was fetched with variables `%s`, but rendered ' +
      'with variables `%s`. This can indicate one of two possibilities: \n' +
      ' - The parent set the correct variables in the query - ' +
      '`%s.getFragment(\'%s\', {...})` - but did not pass the same ' +
      'variables when rendering the component. Be sure to tell the ' +
      'component what variables to use by passing them as props: ' +
      '`<%s ... %s />`.\n' +
      ' - You are intentionally passing fake data to this ' +
      'component, in which case ignore this warning.',
      componentName,
      fragmentName,
      fetchedVariables ?
        fetchedVariables.map(vars => JSON.stringify(vars)).join(', ') :
        '(not fetched)',
      JSON.stringify(variables),
      componentName,
      fragmentName,
      componentName,
      Object.keys(variables).map(key => {
        return `${key}={...}`;
      }).join(' ')
    );
  }
  return hasFragmentData;
}

module.exports = {create};
