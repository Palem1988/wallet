/**
Template Controllers

@module Templates
*/


/**
The transaction info template

@class [template] views_modals_transactionInfo
@constructor
*/



Template['views_modals_transactionInfo'].helpers({
    /**
    Returns the current transaction

    @method (transaction)
    @return {Object} the current transaction
    */
    'transaction': function() {
        return Transactions.findOne(this._id);
    },
    /**
    Calculates the confirmations of this tx

    @method (confirmations)
    @return {Number} the number of confirmations
    */
    'confirmations': function(){
        return (SeroBlocks.latest && this.blockNumber)
            ? SeroBlocks.latest.number + 1 - this.blockNumber : 0;
    },
    /**
     Token value

     @method (tokenValue)
     */
    'tokenValue': function() {
        var token = Tokens.findOne(this.tokenId);

        return (token) ? Helpers.formatNumberByDecimals(this.value, token.decimals) +' '+ token.symbol : this.value;
    },

    /**
     Token value

     @method (tokenValue)
     */
    'tknValue': function() {
        return Helpers.formatNumberByDecimals(this.value, this.decimals) ;
    },


    /**
    Gas Price per million

    @method (gasPricePerMillion)
    */
    'gasPricePerMillion': function() {
        return this.gasPrice;
    },

    /**
     Shortens the address to 0xffff...ffff

     @method (shortenAddress)
     */
    'shortenAddress': function (address) {
        if (_.isString(address)) {
            return address.substr(0, 20) + '...' + address.substr(-20);
        }
    },

    'txFee': function() {
        console.log('this.gasPrice:::',this.gasPrice, typeof this.gasPrice);
        if(!this.gasPrice || (typeof this.gasPrice === "object")){
            return '0';
        }
        return new BigNumber(this.gasPrice.toString(10)).times(this.gasUsed) ;
    },

});

