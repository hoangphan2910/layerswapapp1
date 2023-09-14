import { erc20ABI } from 'wagmi';
import { parseEther, encodeFunctionData, PublicClient, formatGwei } from 'viem'
import { multicall, fetchBalance, FetchBalanceResult } from '@wagmi/core'
import { BaseL2Asset, Layer } from '../Models/Layer';
import { Currency } from '../Models/Currency';
import KnownInternalNames from '../lib/knownIds';
import { estimateFees } from '../lib/optimism/estimateFees';

export type ERC20ContractRes = ({
    error: Error;
    result?: undefined;
    status: "failure";
} | {
    error?: undefined;
    result: unknown;
    status: "success";
})

export type Balance = {
    network: string,
    amount: number,
    decimals: number,
    isNativeCurrency: boolean,
    token: string,
    request_time: string,
}

export type Gas = {
    token: string,
    gas: number,
    gasDetails?: {
        gasLimit: number,
        maxFeePerGas: number,
        gasPrice: number,
        maxPriorityFeePerGas: number
    }
}

export const resolveFeeData = async (publicClient: PublicClient) => {
    try {

        const gasPrice = await publicClient.getGasPrice()
        const feesPerGas = await publicClient.estimateFeesPerGas()
        const maxPriorityFeePerGas = await publicClient.estimateMaxPriorityFeePerGas()

        return { gasPrice, maxFeePerGas: feesPerGas.maxFeePerGas, maxPriorityFeePerGas: maxPriorityFeePerGas }
    } catch (e) {
        //TODO: log the error to our logging service
        console.log(e)
        return null;
    }
}

export const resolveERC20Balances = async (
    multicallRes: ERC20ContractRes[],
    from: Layer & { isExchange: false },
) => {
    const contractBalances = multicallRes?.map((d, index) => {
        const currency = from?.assets?.filter(a => a.contract_address && a.status !== 'inactive')[index]
        return {
            network: from.internal_name,
            token: currency.asset,
            amount: formatAmount(d.result, currency?.decimals),
            request_time: new Date().toJSON(),
            decimals: currency.decimals,
            isNativeCurrency: false,
        }
    })
    return contractBalances
}
type GetBalanceArgs = {
    address: string,
    chainId: number,
    assets: BaseL2Asset[],
    publicClient: PublicClient,
    hasMulticall: boolean
}
export const getErc20Balances = async ({
    address,
    chainId,
    assets,
    publicClient,
    hasMulticall = false
}: GetBalanceArgs): Promise<ERC20ContractRes[] | null> => {

    const contracts = assets?.filter(a => a.contract_address && a.status !== 'inactive').map(a => ({
        address: a?.contract_address as `0x${string}`,
        abi: erc20ABI,
        functionName: 'balanceOf',
        args: [address],
    }))

    try {
        if (hasMulticall) {
            const contractRes = await multicall({
                chainId: chainId,
                contracts: contracts
            })
            return contractRes
        }
        else {
            const balances: ERC20ContractRes[] = []
            for (let i = 0; i < contracts.length; i++) {
                try {
                    const contract = contracts[i]
                    const balance = await publicClient.readContract({
                        address: contract?.address as `0x${string}`,
                        abi: erc20ABI,
                        functionName: 'balanceOf',
                        args: [address as `0x${string}`]
                    })
                    balances.push({
                        status: "success",
                        result: balance,
                        error: null
                    })
                }
                catch (e) {
                    balances.push({
                        status: "failure",
                        result: null,
                        error: e?.message
                    })
                }
            }
            return balances
        }
    }
    catch (e) {
        //TODO: log the error to our logging service
        console.log(e);
        return null;
    }

}

export const getNativeBalance = async (address: `0x${string}`, chainId: number): Promise<FetchBalanceResult | null> => {

    try {
        const nativeTokenRes = await fetchBalance({
            address,
            chainId
        })
        return nativeTokenRes
    } catch (e) {
        //TODO: log the error to our logging service
        console.log(e)
        return null
    }

}

export const resolveNativeBalance = async (
    from: Layer & { isExchange: false },
    nativeTokenRes: FetchBalanceResult
) => {
    const native_currency = from.assets.find(a => a.asset === from.native_currency)
    const nativeBalance: Balance = {
        network: from.internal_name,
        token: from.native_currency,
        amount: formatAmount(nativeTokenRes?.value, native_currency?.decimals),
        request_time: new Date().toJSON(),
        decimals: native_currency.decimals,
        isNativeCurrency: true,
    }

    return nativeBalance
}

export const estimateNativeGasLimit = async (publicClient: PublicClient, account: `0x${string}`, destination: `0x${string}`) => {

    const to = destination;

    let encodedData = encodeFunctionData({
        abi: erc20ABI,
        functionName: 'transfer',
        args: [
            to,
            parseEther("0.1"),
        ]
    });

    const hexed_sequence_number = (99999999).toString(16)
    const sequence_number_even = hexed_sequence_number?.length % 2 > 0 ? `0${hexed_sequence_number}` : hexed_sequence_number

    encodedData = encodedData ? `${encodedData}${sequence_number_even}` as `0x${string}` : null;

    const gasEstimate = await publicClient.estimateGas({
        account: account,
        to: to,
        data: encodedData,
    })

    return gasEstimate
}

export const estimateERC20GasLimit = async (publicClient: any, contract_address: `0x${string}`, account: `0x${string}`, destination: `0x${string}`) => {

    let encodedData = encodeFunctionData({
        abi: erc20ABI,
        functionName: "transfer",
        args: ['0x5dA5C2a98e26FD28914b91212b1232D58eb9bbab', BigInt(1000)]
    })

    const hexed_sequence_number = (99999999).toString(16)
    const sequence_number_even = hexed_sequence_number?.length % 2 > 0 ? `0${hexed_sequence_number}` : hexed_sequence_number

    encodedData = encodedData ? `${encodedData}${sequence_number_even}` as `0x${string}` : null;

    const estimatedERC20GasLimit = await publicClient.estimateGas({
        data: encodedData,
        to: contract_address,
        account
    });

    return estimatedERC20GasLimit
}

export const resolveGas = async (publicClient: any, chainId: number, contract_address: `0x${string}`, account: `0x${string}`, from: Layer, currency: Currency, destination: `0x${string}`) => {
    const nativeToken = from.isExchange === false && from.assets.find(a => a.asset === from.native_currency)

    let fee: Gas

    switch (from.internal_name) {
        case KnownInternalNames.Networks.OptimismMainnet:
            fee = await GetOptimismGas(publicClient, chainId, account, nativeToken, currency)
            break;
        default:
            fee = await GetGas(publicClient, account, nativeToken, currency, contract_address, destination)
    }

    return fee
}

const GetOptimismGas = async (publicClient: PublicClient, chainId: number, account: `0x${string}`, nativeToken: BaseL2Asset, currency: Currency): Promise<Gas> => {

    var dummyAddress = "0x3535353535353535353535353535353535353535" as const;
    const amount = BigInt(1000000000)

    const fee = await estimateFees({
        client: publicClient,
        functionName: 'transfer',
        abi: erc20ABI,
        args: [dummyAddress, amount],
        account: account,
        chainId: chainId,
        to: dummyAddress
    })

    const gas = formatAmount(fee, nativeToken?.decimals)

    return { gas: gas, token: currency?.asset }
}

const GetGas = async (publicClient: PublicClient, account: `0x${string}`, nativeBalance: BaseL2Asset, currency: Currency, contract_address: `0x${string}`, destination: `0x${string}`) => {

    const feeData = await resolveFeeData(publicClient)

    const estimatedGasLimit = contract_address ?
        await estimateERC20GasLimit(publicClient, contract_address, account, destination)
        : await estimateNativeGasLimit(publicClient, account, destination)

    const totalGas = feeData.maxFeePerGas
        ? (feeData?.maxFeePerGas * estimatedGasLimit)
        : (feeData?.gasPrice * estimatedGasLimit)

    const formattedGas = formatAmount(totalGas, nativeBalance?.decimals)

    return {
        gas: formattedGas,
        token: currency?.asset,
        gasDetails: {
            gasLimit: Number(estimatedGasLimit),
            maxFeePerGas: Number(formatGwei(feeData?.maxFeePerGas)),
            gasPrice: Number(formatGwei(feeData?.gasPrice)),
            maxPriorityFeePerGas: Number(formatGwei(feeData?.maxPriorityFeePerGas)),
        }
    }
}

export const formatAmount = (unformattedAmount: bigint | unknown, decimals: number) => {
    return (Number(BigInt(unformattedAmount?.toString() || 0)) / Math.pow(10, decimals))
}